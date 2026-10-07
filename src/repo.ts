import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
    if (!/[.:]/.test(first) && first !== 'localhost') {
      throw new LoadoutError(`Repository id "${input}" must include the host, e.g. github.com/${s}`);
    }
    host = first;
    path = rest.join('/');
  }
  path = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  if (!host || !path) throw new LoadoutError(`Cannot parse repository id from "${input}"`);
  return `${host}/${path}`.toLowerCase();
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

export { git as runGit };
