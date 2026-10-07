import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ADAPTERS } from './adapters/index.js';
import { attachServers } from './bindings-edit.js';
import { LoadoutError } from './errors.js';
import { SECRET_NAME, serverFileContent, serverPath, type Registry } from './registry.js';
import { findProjects } from './repo.js';
import type { HttpTransportDef, ParamSpec, RepoContext, ServerDef, StdioTransportDef } from './types.js';
import type { State } from './writer.js';

const EXACT_VERSION = /^[0-9]+\.[0-9]+(\.[0-9]+)?([-.+][0-9A-Za-z.+-]+)?$/;
/** ${VAR}, ${env:VAR}, ${VAR:-default} */
const ENV_REF = /^\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}$/;

export function normalizeServerName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'server'
  );
}

function envName(s: string): string {
  return s
    .replace(/^-+/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toUpperCase();
}

interface ConvertContext {
  server: string;
  /** Repository root; absolute paths under it become {{ repo.root }}. */
  root?: string;
  params: Record<string, ParamSpec>;
  notes: string[];
}

/** Replace a secret value with a secret param; the literal value is never kept. */
function secretParam(ctx: ConvertContext, value: string, suggested: string, where: string, exact = false): string {
  // Already a placeholder the user typed: keep it, as a per-repository secret param.
  const placeholder = /^\{\{\s*params\.([A-Za-z_]\w*)\s*\}\}$/.exec(value.trim());
  if (placeholder) {
    ctx.params[placeholder[1]] = { type: 'secret', required: true };
    return value.trim();
  }
  const ref = ENV_REF.exec(value.trim());
  const prefix = envName(ctx.server);
  let name = ref ? ref[1] : exact ? suggested : envName(suggested);
  if (!ref && !exact && !name.startsWith(`${prefix}_`) && name !== prefix) name = `${prefix}_${name}`;
  ctx.params[name] = { type: 'secret', default: `env://${name}` };
  if (!ref && value) ctx.notes.push(`${ctx.server}: secret in ${where} was NOT copied — export ${name} in your shell`);
  return `{{ params.${name} }}`;
}

/** Make a non-secret value portable: workspace/repo paths become {{ repo.root }}. */
function portable(ctx: ConvertContext, value: string, where: string): string {
  let out = value.replaceAll('${workspaceFolder}', '{{ repo.root }}');
  if (ctx.root && ctx.root.length > 1) out = out.replaceAll(ctx.root, '{{ repo.root }}');
  if (/\$\{[^}]+\}/.test(out))
    ctx.notes.push(`${ctx.server}: ${where} keeps a client-specific variable (${value}); check it works in every client`);
  return out;
}

function convertArgs(ctx: ConvertContext, args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const kv = /^(-{0,2}[A-Za-z_][\w-]*)=(.*)$/.exec(arg);
    if (kv && SECRET_NAME.test(kv[1])) {
      out.push(`${kv[1]}=${secretParam(ctx, kv[2], kv[1], `argument ${kv[1]}`)}`);
    } else if (/^--?[\w-]+$/.test(arg) && SECRET_NAME.test(arg) && i + 1 < args.length && !args[i + 1].startsWith('-')) {
      out.push(arg, secretParam(ctx, args[++i], arg, `argument ${arg}`));
    } else {
      out.push(portable(ctx, arg, `argument "${arg}"`));
    }
  }
  return out;
}

function convertStdio(ctx: ConvertContext, cfg: Record<string, unknown>): StdioTransportDef {
  const command = String(cfg.command);
  let args = Array.isArray(cfg.args) ? cfg.args.map(String) : [];
  const t: StdioTransportDef = { type: 'stdio' };
  const runner = command.replace(/\.cmd$/, '');
  if (runner === 'npx' || runner === 'uvx') {
    const flags = new Set(runner === 'npx' ? ['-y', '--yes', '-q', '--quiet'] : ['-q', '--quiet']);
    let i = 0;
    while (i < args.length && flags.has(args[i])) i++;
    const spec = args[i];
    const m =
      spec === undefined || spec.startsWith('-')
        ? null
        : runner === 'npx'
          ? /^(@?[^@]+)@(.+)$/.exec(spec)
          : /^([^=@]+)(?:==|@)(.+)$/.exec(spec);
    if (m && EXACT_VERSION.test(m[2])) {
      t.package = { registry: runner === 'npx' ? 'npm' : 'pypi', name: m[1], version: m[2] };
      args = args.slice(i + 1);
    } else {
      ctx.notes.push(
        `${ctx.server}: "${command} ${spec ?? ''}" is not pinned to an exact version — kept as a raw command; pin it in servers/${ctx.server}.yaml`,
      );
    }
  }
  if (!t.package) t.command = portable(ctx, command, 'command');
  const converted = convertArgs(ctx, args);
  if (converted.length) t.args = converted;
  const env = (cfg.env ?? {}) as Record<string, unknown>;
  if (Object.keys(env).length) {
    t.env = {};
    for (const [k, v] of Object.entries(env)) {
      t.env[k] = SECRET_NAME.test(k)
        ? secretParam(ctx, String(v), k, `env ${k}`, /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
        : portable(ctx, String(v), `env ${k}`);
    }
  }
  return t;
}

function convertHttp(ctx: ConvertContext, cfg: Record<string, unknown>): HttpTransportDef {
  if (cfg.type === 'sse')
    ctx.notes.push(`${ctx.server}: SSE transport imported as http — check the server supports streamable HTTP`);
  let url = String(cfg.url);
  const [base, query] = url.split('?', 2);
  if (query) {
    const pairs = query.split('&').map((pair) => {
      const [k, v = ''] = pair.split('=');
      return SECRET_NAME.test(k) ? `${k}=${secretParam(ctx, decodeURIComponent(v), k, `url query ${k}`)}` : pair;
    });
    url = `${base}?${pairs.join('&')}`;
  }
  const t: HttpTransportDef = { type: 'http', url };
  const headers = (cfg.headers ?? {}) as Record<string, unknown>;
  if (Object.keys(headers).length) {
    t.headers = {};
    for (const [k, raw] of Object.entries(headers)) {
      const v = String(raw);
      if (!SECRET_NAME.test(k)) {
        t.headers[k] = portable(ctx, v, `header ${k}`);
        continue;
      }
      const scheme = /^(Bearer|Basic|Token)\s+(.+)$/i.exec(v);
      t.headers[k] = scheme
        ? `${scheme[1]} ${secretParam(ctx, scheme[2], 'token', `header ${k}`)}`
        : secretParam(ctx, v, k, `header ${k}`);
    }
  }
  return t;
}

const KNOWN_FIELDS = new Set(['type', 'command', 'args', 'env', 'url', 'headers']);

/** Convert one client config entry (Claude Code / Cursor / VS Code shape) into a server definition. */
export function convertEntry(rawName: string, cfg: Record<string, unknown>, root?: string) {
  const name = normalizeServerName(rawName);
  const ctx: ConvertContext = { server: name, root, params: {}, notes: [] };
  if (name !== rawName) ctx.notes.push(`"${rawName}" renamed to "${name}"`);
  for (const k of Object.keys(cfg))
    if (!KNOWN_FIELDS.has(k)) ctx.notes.push(`${name}: field "${k}" is not supported and was ignored`);
  let transport: ServerDef['transport'];
  if (typeof cfg.url === 'string') transport = convertHttp(ctx, cfg);
  else if (typeof cfg.command === 'string') transport = convertStdio(ctx, cfg);
  else throw new LoadoutError(`${rawName}: neither "command" nor "url" is set`);
  const def: ServerDef = { name, transport };
  if (Object.keys(ctx.params).length) def.params = ctx.params;
  return { def, notes: ctx.notes };
}

export const comparable = (d: ServerDef) => JSON.stringify({ transport: d.transport, params: d.params ?? {} });

export interface ImportResult {
  repo: string;
  sources: string[];
  /** New shared servers. */
  created: string[];
  /** Existing shared servers with the same definition. */
  reused: string[];
  /** Shared servers no repository used yet, replaced by this repository's definition. */
  replaced: string[];
  /** Same name as a shared server other repositories use, but a different definition: kept as this repository's own. */
  own: string[];
  attached: string[];
  notes: string[];
}

/**
 * Registry view shared by every repository of one import run, so a dry run of many repositories
 * sees the servers earlier repositories would create.
 */
export class ImportSession {
  readonly shared: Map<string, ServerDef>;
  readonly users = new Map<string, Set<string>>();
  constructor(
    readonly registry: Registry,
    readonly opts: { dryRun?: boolean; state?: State } = {},
  ) {
    this.shared = new Map(registry.servers);
    for (const [id, bindings] of registry.bindings) for (const b of bindings) this.use(b.server, id);
  }
  use(server: string, repo: string) {
    if (!this.users.has(server)) this.users.set(server, new Set());
    this.users.get(server)!.add(repo);
  }
  write(def: ServerDef, scope?: string) {
    if (this.opts.dryRun) return;
    const file = serverPath(this.registry, def.name, scope);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, serverFileContent(this.registry, file, def));
  }
}

/** Client config files of a repository that loadout did not generate (hand-written or edited). */
export function handWrittenConfigs(root: string, state?: State): string[] {
  return Object.values(ADAPTERS)
    .map((a) => a.path)
    .filter((p) => {
      const file = join(root, p);
      return existsSync(file) && !(state && state.owns(file, readFileSync(file, 'utf8')));
    });
}

/** Read and convert the MCP servers of a repository's hand-written client configs. */
export function readRepoConfigs(repo: RepoContext, state?: State) {
  const sources = handWrittenConfigs(repo.root, state);
  const found = new Map<string, ServerDef>();
  const notes: string[] = [];
  for (const path of sources) {
    let json: { mcpServers?: Record<string, Record<string, unknown>> };
    try {
      json = JSON.parse(readFileSync(join(repo.root, path), 'utf8'));
    } catch (e) {
      throw new LoadoutError(`${repo.id}: ${path} is not valid JSON (${(e as Error).message})`);
    }
    for (const [rawName, cfg] of Object.entries(json.mcpServers ?? {})) {
      const { def, notes: n } = convertEntry(rawName, cfg, repo.root);
      def.description = `Imported from ${repo.id}`;
      const previous = found.get(def.name);
      if (previous) {
        if (comparable(previous) !== comparable(def))
          notes.push(`${def.name}: differs between client files; using ${sources[0]}`);
        continue;
      }
      notes.push(...n);
      found.set(def.name, def);
    }
  }
  return { sources, found, notes };
}

/** Import the MCP servers configured in a repository's hand-written client files into the registry. */
export function importRepo(
  registry: Registry,
  repo: RepoContext,
  opts: { dryRun?: boolean; repoOnly?: boolean; state?: State; session?: ImportSession } = {},
): ImportResult {
  const session = opts.session ?? new ImportSession(registry, { dryRun: opts.dryRun, state: opts.state });
  const { sources, found, notes } = readRepoConfigs(repo, session.opts.state);
  const result: ImportResult = { repo: repo.id, sources, created: [], reused: [], replaced: [], own: [], attached: [], notes };
  if (!sources.length) {
    throw new LoadoutError(
      `No hand-written MCP config in ${repo.root} (looked for ${Object.values(ADAPTERS)
        .map((a) => a.path)
        .join(', ')})`,
    );
  }
  const attachedNow = new Set((registry.bindings.get(repo.id) ?? []).map((b) => b.server));
  const toAttach: string[] = [];
  for (const def of found.values()) {
    if (opts.repoOnly) {
      if (attachedNow.has(def.name)) {
        result.notes.push(`${def.name}: this repository already uses the shared "${def.name}" — skipped`);
      } else if (registry.repoServers.get(repo.id)?.has(def.name)) {
        result.reused.push(def.name);
      } else {
        result.own.push(def.name);
        session.write(def, repo.id);
      }
      continue;
    }
    const shared = session.shared.get(def.name);
    const others = [...(session.users.get(def.name) ?? [])].filter((id) => id !== repo.id);
    if (!shared) {
      result.created.push(def.name);
      session.shared.set(def.name, def);
      session.write(def);
    } else if (comparable(shared) === comparable(def)) {
      result.reused.push(def.name);
    } else if (attachedNow.has(def.name)) {
      result.reused.push(def.name);
      result.notes.push(`${def.name}: already attached here; kept the registry definition (your file differs)`);
    } else if (!others.length) {
      result.replaced.push(def.name);
      const merged = { ...def, description: shared.description ?? def.description };
      session.shared.set(def.name, merged);
      session.write(merged);
    } else {
      result.own.push(def.name);
      result.notes.push(
        `${def.name}: differs from the shared definition used by ${others.join(', ')} — kept as this repository's own server`,
      );
      if (registry.repoServers.get(repo.id)?.has(def.name)) continue;
      session.write(def, repo.id);
      continue;
    }
    toAttach.push(def.name);
    session.use(def.name, repo.id);
  }
  if (opts.repoOnly) return result;
  if (opts.dryRun || session.opts.dryRun) result.attached = toAttach.filter((n) => !attachedNow.has(n));
  else result.attached = attachServers(registry.bindingsPath, repo.id, toAttach);
  return result;
}

export interface ImportCandidate {
  repo: RepoContext;
  files: string[];
  servers: string[];
  registered: boolean;
}

/** Repositories under the workspaces with hand-written MCP client configs. */
export function findImportCandidates(
  registry: Registry,
  dirs: string[],
  state?: State,
  workspaces: string[] = dirs,
): ImportCandidate[] {
  return importCandidates(registry, findProjects(dirs, workspaces), state);
}

/** Which of these repositories have hand-written MCP client configs. */
export function importCandidates(registry: Registry, repos: RepoContext[], state?: State): ImportCandidate[] {
  const out: ImportCandidate[] = [];
  for (const repo of repos) {
    const files = handWrittenConfigs(repo.root, state);
    if (!files.length) continue;
    let servers: string[] = [];
    try {
      servers = [...readRepoConfigs(repo, state).found.keys()];
    } catch {
      servers = []; // invalid JSON: reported when importing
    }
    out.push({ repo, files, servers, registered: registry.bindings.has(repo.id) || registry.repoServers.has(repo.id) });
  }
  return out;
}
