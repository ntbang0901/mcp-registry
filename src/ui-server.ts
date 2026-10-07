import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  commitAdd,
  entryFromForm,
  makeRepoOnly,
  parseServerJson,
  previewAdd,
  readServerSource,
  removeServer,
  shareServer,
  usersOf,
  writeServerSource,
  type AddEntry,
  type FormInput,
} from './add.js';
import { requiredParams, updateBindingParams } from './params.js';
import { attachServers, detachServers } from './bindings-edit.js';
import { stateDir, type Config } from './config.js';
import { LoadoutError } from './errors.js';
import { knownRepos, loadRegistry, loadValidRegistry, type Registry } from './registry.js';
import { detectRepo, findGitRepos, normalizeRepoId, repoContext } from './repo.js';
import { resolveRepo, repoStatus, syncRepo } from './sync.js';
import { secretEnvNames } from './resolve.js';
import type { RepoContext, ServerDef } from './types.js';
import { State } from './writer.js';

export interface UiOptions {
  registryRoot: string;
  config: Config;
  port: number;
}

type Json = Record<string, unknown>;

/** Registry files the UI edits (and may commit). */
const REGISTRY_PATHS = ['servers', 'repos', 'bindings.yaml'];

function git(root: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string };
    throw new LoadoutError((err.stderr || err.stdout || String(e)).trim());
  }
}

function localClones(config: Config): Map<string, RepoContext[]> {
  const clones = new Map<string, RepoContext[]>();
  for (const dir of findGitRepos(config.workspaces)) {
    try {
      const repo = detectRepo(dir);
      clones.set(repo.id, [...(clones.get(repo.id) ?? []), repo]);
    } catch {
      /* no remote */
    }
  }
  return clones;
}

function cloneStatus(registry: Registry, repo: RepoContext, config: Config, state: State) {
  try {
    const files = repoStatus(registry, repo, config.targets, state).files;
    const statuses = files.map((f) => f.status);
    const status = statuses.includes('modified')
      ? 'hand-written'
      : statuses.some((s) => s === 'missing' || s === 'stale' || s === 'orphan')
        ? 'out of sync'
        : 'synced';
    return { path: repo.root, status, files };
  } catch (e) {
    return { path: repo.root, status: 'error', error: (e as Error).message, files: [] };
  }
}

/** Secret env vars a repository's servers read, and whether the shell running the UI has them. */
function repoEnv(registry: Registry, id: string, root: string) {
  try {
    const names = [...new Set(resolveRepo(registry, repoContext(id, root)).flatMap(secretEnvNames))].sort();
    return names.map((name) => ({ name, set: !!process.env[name] }));
  } catch {
    return [];
  }
}

function buildState(opts: UiOptions): Json {
  const { registry, problems } = loadRegistry(opts.registryRoot);
  const clones = localClones(opts.config);
  const state = State.load(stateDir());
  const valid = !problems.some((p) => p.level === 'error');
  const describe = (def: ServerDef, repo?: string) => {
    const t = def.transport;
    const summary =
      t.type === 'http'
        ? t.url
        : t.package
          ? `${t.package.registry === 'npm' ? 'npx' : 'uvx'} ${t.package.name}${t.package.registry === 'npm' ? '@' : '=='}${t.package.version} ${(t.args ?? []).join(' ')}`.trim()
          : [t.command, ...(t.args ?? [])].join(' ');
    return {
      name: def.name,
      repo: repo ?? null,
      description: def.description ?? '',
      status: def.status ?? '',
      kind: t.type === 'http' ? 'remote' : 'local',
      summary,
      envVars: Object.values(def.params ?? {}).flatMap((p) => (p.type === 'secret' && typeof p.default === 'string' ? [p.default.replace(/^env:\/\//, '')] : [])),
      usedBy: repo ? [repo] : usersOf(registry, def.name),
      params: Object.entries(def.params ?? {}).map(([name, spec]) => ({ name, ...spec })),
    };
  };
  const servers = [...registry.servers.values()].map((def) => describe(def));
  const repoOnly = [...registry.repoServers].flatMap(([id, defs]) => [...defs.values()].map((def) => describe(def, id)));
  const repos = knownRepos(registry).map((id) => ({
    id,
    servers: (registry.bindings.get(id) ?? []).map((b) => b.server),
    own: [...(registry.repoServers.get(id)?.keys() ?? [])],
    params: Object.fromEntries((registry.bindings.get(id) ?? []).map((b) => [b.server, b.params])),
    clones: (clones.get(id) ?? []).map((c) =>
      valid ? cloneStatus(registry, c, opts.config, state) : { path: c.root, status: 'error', error: 'The registry has errors', files: [] },
    ),
    env: valid ? repoEnv(registry, id, clones.get(id)?.[0]?.root ?? '/repo') : [],
  }));
  const known = new Set(knownRepos(registry));
  const unregistered = [...clones].filter(([id]) => !known.has(id)).map(([id, cs]) => ({ id, path: cs[0].root }));
  let changes: string[] = [];
  try {
    changes = (git(opts.registryRoot, ['status', '--porcelain', '--', ...REGISTRY_PATHS]) ?? '').split('\n').filter(Boolean);
  } catch {
    /* not a git repo */
  }
  return {
    registryRoot: opts.registryRoot,
    workspaces: opts.config.workspaces,
    targets: opts.config.targets,
    servers,
    repoOnly,
    repos,
    unregistered,
    problems,
    changes,
  };
}

function addEntries(body: Json): { entries: AddEntry[]; name?: string; description?: string; repo?: string } {
  const description = typeof body.description === 'string' && body.description.trim() ? body.description.trim() : undefined;
  const repo = typeof body.repo === 'string' && body.repo ? normalizeRepoId(body.repo) : undefined;
  if (body.mode === 'form') return { entries: [entryFromForm(body.form as FormInput)], description, repo };
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : undefined;
  return { entries: parseServerJson(String(body.text ?? '')), name, description, repo };
}

function syncClones(opts: UiOptions, body: Json) {
  const { registry } = loadValidRegistry(opts.registryRoot);
  const only = typeof body.repo === 'string' ? normalizeRepoId(body.repo) : undefined;
  const state = State.load(stateDir());
  const results = [];
  for (const [id, clones] of localClones(opts.config)) {
    if (!knownRepos(registry).includes(id) || (only && id !== only)) continue;
    for (const repo of clones) {
      try {
        const r = syncRepo(registry, repo, opts.config.targets, state, { force: body.force === true });
        results.push({ id, path: repo.root, files: r.files, missingEnv: r.missingEnv });
      } catch (e) {
        results.push({ id, path: repo.root, error: (e as Error).message });
      }
    }
  }
  state.save();
  return { results };
}

async function handleApi(req: IncomingMessage, url: URL, body: Json, opts: UiOptions): Promise<unknown> {
  const route = `${req.method} ${url.pathname}`;
  const registry = () => loadRegistry(opts.registryRoot).registry;
  switch (route) {
    case 'GET /api/state':
      return buildState(opts);
    case 'POST /api/preview': {
      const { entries, name, description, repo } = addEntries(body);
      return previewAdd(registry(), entries, { name, description, repo });
    }
    case 'POST /api/servers': {
      const reg = registry();
      const { entries, name, description, repo } = addEntries(body);
      const preview = previewAdd(reg, entries, { name, description, repo });
      const written = commitAdd(reg, preview, { overwrite: body.overwrite === true });
      if (repo) return { written, attached: [repo], needsParams: [] };
      // Servers with required params are attached later, from the repository, once values are entered.
      const fresh = loadRegistry(opts.registryRoot).registry;
      const ready = written.filter((n) => !requiredParams(fresh.servers.get(n)!).length);
      const attachTo = (Array.isArray(body.attach) ? body.attach.map(String) : []).map((r) => normalizeRepoId(r));
      for (const r of attachTo) if (ready.length) attachServers(reg.bindingsPath, r, ready);
      return { written, attached: ready.length ? attachTo : [], needsParams: written.length > ready.length ? attachTo : [] };
    }
    case 'POST /api/bindings': {
      const reg = registry();
      const repo = normalizeRepoId(String(body.repo ?? ''));
      const server = String(body.server ?? '');
      if (body.attached) {
        const def = reg.servers.get(server);
        if (!def) throw new LoadoutError(`Unknown server "${server}"`);
        const required = requiredParams(def);
        if (required.length) throw new LoadoutError(`${server} needs values for ${required.join(', ')} before it can be added`);
        attachServers(reg.bindingsPath, repo, [server]);
      } else {
        detachServers(reg.bindingsPath, repo, [server]);
      }
      return { ok: true };
    }
    case 'POST /api/repos': {
      attachServers(registry().bindingsPath, normalizeRepoId(String(body.repo ?? '')), []);
      return { ok: true };
    }
    case 'POST /api/share': {
      shareServer(registry(), normalizeRepoId(String(body.repo ?? '')), String(body.name ?? ''));
      return { ok: true };
    }
    case 'POST /api/unshare': {
      return { repo: makeRepoOnly(registry(), String(body.name ?? ''), body.repo ? normalizeRepoId(String(body.repo)) : undefined) };
    }
    case 'POST /api/params': {
      const params = updateBindingParams(
        registry(),
        normalizeRepoId(String(body.repo ?? '')),
        String(body.server ?? ''),
        (body.params ?? {}) as Record<string, unknown>,
        { replace: true, attach: body.attach === true },
      );
      return { params };
    }
    case 'POST /api/sync':
      return syncClones(opts, body);
    case 'POST /api/commit': {
      const message = String(body.message ?? '').trim() || 'Update MCP registry';
      // -A stages deletions too. Skip paths that neither exist nor are tracked (e.g. no repos/ yet).
      const paths = REGISTRY_PATHS.filter(
        (p) => existsSync(join(opts.registryRoot, p)) || git(opts.registryRoot, ['ls-files', '--', p])?.trim(),
      );
      git(opts.registryRoot, ['add', '-A', '--', ...paths]);
      return { output: git(opts.registryRoot, ['commit', '-m', message, '--', ...paths])?.trim() };
    }
  }
  const source = /^\/api\/servers\/([^/]+)\/source$/.exec(url.pathname);
  if (source) {
    const name = decodeURIComponent(source[1]);
    const repo = url.searchParams.get('repo') ? normalizeRepoId(url.searchParams.get('repo')!) : undefined;
    if (req.method === 'GET') return readServerSource(registry(), name, repo);
    if (req.method === 'PUT') return { warnings: writeServerSource(registry(), name, String(body.yaml ?? ''), repo) };
  }
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/servers/')) {
    const repo = url.searchParams.get('repo');
    removeServer(registry(), decodeURIComponent(url.pathname.slice('/api/servers/'.length)), repo ? normalizeRepoId(repo) : undefined);
    return { ok: true };
  }
  return undefined;
}

function readBody(req: IncomingMessage): Promise<Json> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new LoadoutError('Request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new LoadoutError('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json') {
  const payload = type === 'application/json' ? JSON.stringify(body) : String(body);
  res.writeHead(status, {
    'Content-Type': `${type}; charset=utf-8`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(payload);
}

/**
 * Local web UI. Binds to 127.0.0.1 only; every request needs the per-session token
 * (in the page URL, then an X-Loadout-Token header), and the Host header must be local.
 */
export function startUi(opts: UiOptions): Promise<{ url: string; close: () => void }> {
  const token = randomBytes(16).toString('hex');
  const html = readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
  const server = createServer(async (req, res) => {
    const port = (server.address() as { port: number }).port;
    const hostOk = [`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host ?? '');
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (!hostOk) return send(res, 403, { error: 'Forbidden host' });
    if (url.pathname === '/' && req.method === 'GET') {
      if (url.searchParams.get('token') !== token) return send(res, 403, 'Open the URL printed by `loadout ui` (it includes the access token).', 'text/plain');
      return send(res, 200, html, 'text/html');
    }
    if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
    if (req.headers['x-loadout-token'] !== token) return send(res, 403, { error: 'Missing or invalid token' });
    try {
      const body = req.method === 'GET' ? {} : await readBody(req);
      const result = await handleApi(req, url, body, opts);
      if (result === undefined) return send(res, 404, { error: 'Not found' });
      send(res, 200, result);
    } catch (e) {
      if (e instanceof LoadoutError) return send(res, 400, { error: e.message });
      console.error(e);
      send(res, 500, { error: (e as Error).message });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${port}/?token=${token}`, close: () => server.close() });
    });
  });
}
