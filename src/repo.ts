import { execFileSync } from 'node:child_process';
import { type Dirent, existsSync, readdirSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { LoadoutError } from './errors.js';
import type { RepoContext } from './types.js';

/**
 * Normalize a git remote URL or an id into `host/owner/name` (lowercase, no `.git`).
 * Accepts https/ssh URLs, scp-like `git@host:owner/name.git`, and `host/owner/name`.
 */
export function normalizeRepoId(input: string): string {
  const s = input.trim();
  let host: string;
  let path: string;
  const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(s);
  if (s.includes('://')) {
    let url: URL;
    try {
      url = new URL(s);
    } catch {
      throw new LoadoutError(`Cannot parse repository URL "${input}"`);
    }
    host = url.hostname;
    path = url.pathname;
  } else if (scp) {
    host = scp[1];
    path = scp[2];
  } else {
    const [first, ...rest] = s.split('/');
    if (!/[.:]/.test(first) && first !== 'localhost' && first !== LOCAL_HOST) {
      throw new LoadoutError(`Repository id "${input}" must include the host, e.g. github.com/${s}`);
    }
    host = first;
    path = rest.join('/');
  }
  path = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  if (!host || !path) throw new LoadoutError(`Cannot parse repository id from "${input}"`);
  return `${host}/${path}`.toLowerCase();
}

/** Host part of ids for projects without a git remote: local/<path inside the workspace>. */
export const LOCAL_HOST = 'local';

const slug = (segment: string) =>
  segment
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || '_';

/**
 * Id for a project without a git remote: its path inside the workspace that contains it, so the same
 * folder layout on another machine maps to the same id. Outside every workspace, the folder name.
 */
export function localProjectId(root: string, workspaces: string[]): string {
  const abs = resolve(root);
  const inside = workspaces
    .map((w) => resolve(w))
    .filter((w) => abs !== w && !relative(w, abs).startsWith('..') && !isAbsolute(relative(w, abs)))
    .sort((a, b) => b.length - a.length)[0];
  const rel = inside ? relative(inside, abs) : basename(abs);
  return [LOCAL_HOST, ...rel.split(sep).filter(Boolean).map(slug)].join('/');
}

export function repoContext(id: string, root: string): RepoContext {
  const [host, ...segments] = id.split('/');
  return {
    id,
    root,
    host,
    slug: segments.join('/'),
    owner: segments.slice(0, -1).join('/'),
    name: segments[segments.length - 1],
  };
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

/** Detect the repository containing `dir` and derive its id from the `origin` remote. */
export function detectRepo(dir: string): RepoContext {
  const root = git(dir, ['rev-parse', '--show-toplevel']);
  if (!root) throw new LoadoutError(`${dir} is not inside a git repository`);
  let remote = git(root, ['remote', 'get-url', 'origin']);
  if (!remote) {
    const first = git(root, ['remote'])?.split('\n')[0];
    if (first) remote = git(root, ['remote', 'get-url', first]);
  }
  if (!remote) throw new LoadoutError(`${root} has no git remote; pass --repo <host/owner/name>`);
  return repoContext(normalizeRepoId(remote), resolve(root));
}

/**
 * The project containing `dir`: a git repository identified by its remote, or (without a remote, or
 * without git at all) a folder identified by its path inside the workspaces. A folder outside git is
 * the directory itself.
 */
export function detectProject(dir: string, workspaces: string[] = []): RepoContext {
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  if (top) {
    let remote = git(top, ['remote', 'get-url', 'origin']);
    if (!remote) {
      const first = git(top, ['remote'])?.split('\n')[0];
      if (first) remote = git(top, ['remote', 'get-url', first]);
    }
    if (remote) {
      try {
        return repoContext(normalizeRepoId(remote), resolve(top));
      } catch {
        /* unusual remote: fall back to the path */
      }
    }
    return repoContext(localProjectId(top, workspaces), resolve(top));
  }
  const root = resolve(dir);
  if (!existsSync(root)) throw new LoadoutError(`${dir} does not exist`);
  return repoContext(localProjectId(root, workspaces), root);
}

const MCP_FILES = ['.mcp.json', join('.cursor', 'mcp.json')];

/**
 * Projects under `dirs`: git repositories, and folders outside git that hold an MCP client config.
 * The walk does not descend into a project once found. Ids of folders without a git remote are
 * relative to `workspaces` (the configured ones; defaults to `dirs`).
 */
export function findProjects(dirs: string[], workspaces: string[] = dirs, maxDepth = 4): RepoContext[] {
  const roots: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (existsSync(join(dir, '.git')) || MCP_FILES.some((f) => existsSync(join(dir, f)))) {
      roots.push(dir);
      return;
    }
    if (depth >= maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) walk(join(dir, e.name), depth + 1);
    }
  };
  for (const w of dirs) {
    const root = resolve(w);
    let entries: Dirent[] = [];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    // Usually a workspace is a folder of projects. If nothing inside it is a project but the folder
    // itself is one (you picked a single project), take it.
    const before = roots.length;
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) walk(join(root, e.name), 1);
    }
    if (roots.length === before && (existsSync(join(root, '.git')) || MCP_FILES.some((f) => existsSync(join(root, f))))) {
      roots.push(root);
    }
  }
  const out = new Map<string, RepoContext>();
  for (const dir of roots) {
    try {
      const p = detectProject(dir, workspaces);
      if (!out.has(p.root)) out.set(p.root, p);
    } catch {
      /* unreadable */
    }
  }
  return [...out.values()];
}

const SKIP_DIRS = new Set(['node_modules', 'vendor', 'target', 'dist', 'build']);

/** Find git working trees under the workspace directories (not descending into a repo once found). */
export function findGitRepos(workspaces: string[], maxDepth = 3): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (existsSync(join(dir, '.git'))) {
      found.push(dir);
      return;
    }
    if (depth >= maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) walk(join(dir, e.name), depth + 1);
    }
  };
  for (const w of workspaces) walk(resolve(w), 0);
  return found;
}

export function isTracked(root: string, relPath: string): boolean {
  return git(root, ['ls-files', '--error-unmatch', '--', relPath]) !== undefined;
}

/** Absolute path of `.git/info/exclude` (works for worktrees too). */
export function gitExcludePath(root: string): string | undefined {
  const p = git(root, ['rev-parse', '--git-path', 'info/exclude']);
  return p ? resolve(root, p) : undefined;
}

/** The workspace containing `dir` (or equal to it), if any. */
export function workspaceOf(dir: string, workspaces: string[]): string | undefined {
  const abs = resolve(dir);
  return workspaces
    .map((w) => resolve(w))
    .find((w) => abs === w || (!relative(w, abs).startsWith('..') && !isAbsolute(relative(w, abs))));
}

export { git as runGit };
