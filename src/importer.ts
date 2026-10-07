import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { ADAPTERS } from './adapters/index.js';
import { attachServers } from './bindings-edit.js';
import { LoadoutError } from './errors.js';
import { SECRET_NAME, SERVERS_DIR, type Registry } from './registry.js';
import type { HttpTransportDef, ParamSpec, RepoContext, ServerDef, StdioTransportDef } from './types.js';

export const SERVER_HEADER = '# yaml-language-server: $schema=../schemas/server.schema.json\n';

const EXACT_VERSION = /^[0-9]+\.[0-9]+(\.[0-9]+)?([-.+][0-9A-Za-z.+-]+)?$/;
/** ${VAR}, ${env:VAR}, ${VAR:-default} */
const ENV_REF = /^\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}$/;

export function normalizeServerName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'server';
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
  if (/\$\{[^}]+\}/.test(out)) ctx.notes.push(`${ctx.server}: ${where} keeps a client-specific variable (${value}); check it works in every client`);
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
      ctx.notes.push(`${ctx.server}: "${command} ${spec ?? ''}" is not pinned to an exact version — kept as a raw command; pin it in servers/${ctx.server}.yaml`);
    }
  }
  if (!t.package) t.command = portable(ctx, command, 'command');
  const converted = convertArgs(ctx, args);
  if (converted.length) t.args = converted;
  const env = (cfg.env ?? {}) as Record<string, unknown>;
  if (Object.keys(env).length) {
    t.env = {};
    for (const [k, v] of Object.entries(env)) {
      t.env[k] = SECRET_NAME.test(k) ? secretParam(ctx, String(v), k, `env ${k}`, /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) : portable(ctx, String(v), `env ${k}`);
    }
  }
  return t;
}

function convertHttp(ctx: ConvertContext, cfg: Record<string, unknown>): HttpTransportDef {
  if (cfg.type === 'sse') ctx.notes.push(`${ctx.server}: SSE transport imported as http — check the server supports streamable HTTP`);
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
  for (const k of Object.keys(cfg)) if (!KNOWN_FIELDS.has(k)) ctx.notes.push(`${name}: field "${k}" is not supported and was ignored`);
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
  sources: string[];
  created: string[];
  reused: string[];
  attached: string[];
  notes: string[];
}

/** Import the MCP servers configured in a repository's client files into the registry. */
export function importRepo(registry: Registry, repo: RepoContext, opts: { dryRun?: boolean } = {}): ImportResult {
  const result: ImportResult = { sources: [], created: [], reused: [], attached: [], notes: [] };
  const found = new Map<string, ServerDef>();
  for (const adapter of Object.values(ADAPTERS)) {
    const file = join(repo.root, adapter.path);
    if (!existsSync(file)) continue;
    let json: { mcpServers?: Record<string, Record<string, unknown>> };
    try {
      json = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      throw new LoadoutError(`${adapter.path}: invalid JSON (${(e as Error).message})`);
    }
    result.sources.push(adapter.path);
    for (const [rawName, cfg] of Object.entries(json.mcpServers ?? {})) {
      const { def, notes } = convertEntry(rawName, cfg, repo.root);
      def.description = `Imported from ${repo.id}`;
      const previous = found.get(def.name);
      if (previous) {
        if (comparable(previous) !== comparable(def)) result.notes.push(`${def.name}: differs between client files; using the first one`);
        continue;
      }
      result.notes.push(...notes);
      found.set(def.name, def);
    }
  }
  if (!result.sources.length) {
    throw new LoadoutError(`No MCP config found in ${repo.root} (looked for ${Object.values(ADAPTERS).map((a) => a.path).join(', ')})`);
  }
  for (const def of found.values()) {
    const existing = registry.servers.get(def.name);
    if (existing) {
      result.reused.push(def.name);
      if (comparable(existing) !== comparable(def)) {
        result.notes.push(`${def.name}: servers/${def.name}.yaml already exists with a different definition — kept the registry version`);
      }
      continue;
    }
    result.created.push(def.name);
    if (!opts.dryRun) {
      mkdirSync(join(registry.root, SERVERS_DIR), { recursive: true });
      writeFileSync(join(registry.root, SERVERS_DIR, `${def.name}.yaml`), SERVER_HEADER + YAML.stringify(def));
    }
  }
  const names = [...found.keys()];
  if (opts.dryRun) {
    const current = new Set((registry.bindings.get(repo.id) ?? []).map((b) => b.server));
    result.attached = names.filter((n) => !current.has(n));
  } else {
    result.attached = attachServers(registry.bindingsPath, repo.id, names);
  }
  return result;
}
