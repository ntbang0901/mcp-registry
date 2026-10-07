import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { commitAdd, entryFromForm, parseServerJson, previewAdd, removeServer, type AddEntry, type FormInput } from './add.js';
import { attachServers, detachServers } from './bindings-edit.js';
import { stateDir, type Config } from './config.js';
import { LoadoutError } from './errors.js';
import { loadRegistry, loadValidRegistry, type Registry } from './registry.js';
import { detectRepo, findGitRepos, normalizeRepoId } from './repo.js';
import { repoStatus, syncRepo } from './sync.js';
import type { RepoContext } from './types.js';
import { State } from './writer.js';

export interface UiOptions {
  registryRoot: string;
  config: Config;
  port: number;
}

type Json = Record<string, unknown>;

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

function summarizeStatus(registry: Registry, repo: RepoContext, config: Config, state: State): string {
  try {
    const statuses = repoStatus(registry, repo, config.targets, state).files.map((f) => f.status);
    if (statuses.includes('modified')) return 'hand-written';
    if (statuses.some((s) => s === 'missing' || s === 'stale' || s === 'orphan')) return 'out of sync';
    return 'synced';
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}

function buildState(opts: UiOptions): Json {
  const { registry, problems } = loadRegistry(opts.registryRoot);
  const clones = localClones(opts.config);
  const state = State.load(stateDir());
  const valid = !problems.some((p) => p.level === 'error');
  const usedBy = (name: string) => [...registry.bindings].filter(([, bs]) => bs.some((b) => b.server === name)).map(([id]) => id);
  const servers = [...registry.servers.values()].map((def) => {
    const t = def.transport;
    const summary =
      t.type === 'http'
        ? t.url
        : t.package
          ? `${t.package.registry === 'npm' ? 'npx' : 'uvx'} ${t.package.name}${t.package.registry === 'npm' ? '@' : '=='}${t.package.version} ${(t.args ?? []).join(' ')}`.trim()
          : [t.command, ...(t.args ?? [])].join(' ');
    return {
      name: def.name,
      description: def.description ?? '',
      status: def.status ?? '',
      kind: t.type === 'http' ? 'remote' : 'local',
      summary,
      envVars: Object.values(def.params ?? {}).flatMap((p) => (p.type === 'secret' && typeof p.default === 'string' ? [p.default.replace(/^env:\/\//, '')] : [])),
      usedBy: usedBy(def.name),
    };
  });
  const repos = [...registry.bindings].map(([id, bindings]) => ({
    id,
    servers: bindings.map((b) => b.server),
    clones: (clones.get(id) ?? []).map((c) => ({ path: c.root, status: valid ? summarizeStatus(registry, c, opts.config, state) : 'registry has errors' })),
  }));
  const unregistered = [...clones].filter(([id]) => !registry.bindings.has(id)).map(([id, cs]) => ({ id, path: cs[0].root }));
  let changes: string[] = [];
  try {
    changes = (git(opts.registryRoot, ['status', '--porcelain', '--', 'servers', 'bindings.yaml']) ?? '').split('\n').filter(Boolean);
  } catch {
    /* not a git repo */
  }
  return {
    registryRoot: opts.registryRoot,
    workspaces: opts.config.workspaces,
    targets: opts.config.targets,
    servers,
    repos,
    unregistered,
    problems,
    changes,
  };
}

function addEntries(body: Json): { entries: AddEntry[]; name?: string; description?: string } {
  const description = typeof body.description === 'string' && body.description.trim() ? body.description.trim() : undefined;
  if (body.mode === 'form') return { entries: [entryFromForm(body.form as FormInput)], description };
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : undefined;
  return { entries: parseServerJson(String(body.text ?? '')), name, description };
}

function syncClones(opts: UiOptions, body: Json) {
  const { registry } = loadValidRegistry(opts.registryRoot);
  const only = typeof body.repo === 'string' ? normalizeRepoId(body.repo) : undefined;
  const state = State.load(stateDir());
  const results = [];
  for (const [id, clones] of localClones(opts.config)) {
    if (!registry.bindings.has(id) || (only && id !== only)) continue;
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
      const { entries, name, description } = addEntries(body);
      return previewAdd(registry(), entries, { name, description });
    }
    case 'POST /api/servers': {
      const reg = registry();
      const { entries, name, description } = addEntries(body);
      const preview = previewAdd(reg, entries, { name, description });
      const written = commitAdd(reg, preview, { overwrite: body.overwrite === true });
      const attachTo = Array.isArray(body.attach) ? body.attach.map(String) : [];
      for (const repo of attachTo) attachServers(reg.bindingsPath, normalizeRepoId(repo), written);
      return { written, attached: attachTo };
    }
    case 'POST /api/bindings': {
      const reg = registry();
      const repo = normalizeRepoId(String(body.repo ?? ''));
      const server = String(body.server ?? '');
      if (body.attached) {
        if (!reg.servers.has(server)) throw new LoadoutError(`Unknown server "${server}"`);
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
    case 'POST /api/sync':
      return syncClones(opts, body);
    case 'POST /api/commit': {
      const message = String(body.message ?? '').trim() || 'Update MCP registry';
      git(opts.registryRoot, ['add', '--', 'servers', 'bindings.yaml']);
      return { output: git(opts.registryRoot, ['commit', '-m', message, '--', 'servers', 'bindings.yaml'])?.trim() };
    }
  }
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/servers/')) {
    removeServer(registry(), decodeURIComponent(url.pathname.slice('/api/servers/'.length)));
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
