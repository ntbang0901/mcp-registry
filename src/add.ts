import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { LoadoutError } from './errors.js';
import { attachServers, detachServers } from './bindings-edit.js';
import { convertEntry, normalizeServerName } from './importer.js';
import YAML from 'yaml';
import {
  checkServer,
  loadRegistry,
  schemaHeader,
  serverFileContent,
  serverPath,
  type Problem,
  type Registry,
} from './registry.js';

export { serverPath } from './registry.js';
import { templateRefs } from './template.js';
import type { ServerDef } from './types.js';

export interface AddEntry {
  name?: string;
  cfg: Record<string, unknown>;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isEntry = (v: unknown) => isObject(v) && (typeof v.command === 'string' || typeof v.url === 'string');

/**
 * Parse MCP config JSON as copied from a README or client config:
 * `{"mcpServers": {...}}`, VS Code's `{"servers": {...}}`, a map of entries,
 * a single entry `{"command": ...}`, or a `"name": {...}` fragment.
 */
export function parseServerJson(text: string): AddEntry[] {
  const trimmed = text.trim();
  if (!trimmed) throw new LoadoutError('Nothing to add: paste an MCP server JSON config');
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch (e) {
    try {
      data = JSON.parse(`{${trimmed.replace(/,\s*$/, '')}}`); // "name": { ... } fragment
    } catch {
      throw new LoadoutError(`Invalid JSON: ${(e as Error).message}`);
    }
  }
  if (!isObject(data)) throw new LoadoutError('Expected a JSON object');
  const map = isObject(data.mcpServers) ? data.mcpServers : isObject(data.servers) ? data.servers : undefined;
  if (map) return Object.entries(map).map(([name, cfg]) => ({ name, cfg: cfg as Record<string, unknown> }));
  if (isEntry(data)) return [{ cfg: data }];
  const entries = Object.entries(data);
  if (entries.length && entries.every(([, v]) => isEntry(v))) {
    return entries.map(([name, cfg]) => ({ name, cfg: cfg as Record<string, unknown> }));
  }
  throw new LoadoutError('No MCP server found: expected "mcpServers", or an object with "command" or "url"');
}

/** Split a command line, honoring single/double quotes, backslash escapes and `{{ ... }}` placeholders. */
export function splitCommandLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '{' && line[i + 1] === '{' && line.indexOf('}}', i) !== -1) {
      const end = line.indexOf('}}', i) + 2;
      cur += line.slice(i, end);
      i = end - 1;
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === '\\' && i + 1 < line.length) {
      cur += line[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
    }
  }
  if (quote) throw new LoadoutError('Unterminated quote in command');
  if (has || cur) out.push(cur);
  return out;
}

/** Parse `KEY=value` or `Header: value` lines (or a list of such strings). */
export function parsePairs(input: string | string[] | undefined): Record<string, string> {
  const lines = Array.isArray(input) ? input : (input ?? '').split('\n');
  const out: Record<string, string> = {};
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([^=:\s]+)\s*(?:=|:)\s*(.*)$/.exec(line);
    if (!m) throw new LoadoutError(`Expected KEY=value, got "${line.length > 30 ? line.slice(0, 30) + '…' : line}"`);
    out[m[1]] = m[2];
  }
  return out;
}

export interface FormInput {
  name: string;
  kind: 'remote' | 'command';
  url?: string;
  command?: string;
  /** Headers (remote) or environment variables (command), one KEY=value per line. */
  pairs?: string | string[];
}

export function entryFromForm(form: FormInput): AddEntry {
  if (!form.name?.trim()) throw new LoadoutError('Name is required');
  const pairs = parsePairs(form.pairs);
  if (form.kind === 'remote') {
    if (!form.url?.trim()) throw new LoadoutError('URL is required');
    return {
      name: form.name,
      cfg: { type: 'http', url: form.url.trim(), ...(Object.keys(pairs).length ? { headers: pairs } : {}) },
    };
  }
  const [command, ...args] = splitCommandLine(form.command ?? '');
  if (!command) throw new LoadoutError('Command is required');
  return { name: form.name, cfg: { command, args, ...(Object.keys(pairs).length ? { env: pairs } : {}) } };
}

/** Every template string of a server's transport. */
function transportTemplates(def: ServerDef): string[] {
  const t = def.transport;
  return t.type === 'http'
    ? [t.url, ...Object.values(t.headers ?? {})]
    : [t.command ?? '', ...(t.args ?? []), ...Object.values(t.env ?? {})];
}

/** Declare `{{ params.x }}` placeholders the user typed as required string params. */
function declarePlaceholders(def: ServerDef): string[] {
  const declared: string[] = [];
  for (const tpl of transportTemplates(def)) {
    let refs;
    try {
      refs = templateRefs(tpl);
    } catch {
      continue; // reported by checkServer
    }
    for (const r of refs) {
      if (r.scope !== 'params' || def.params?.[r.name]) continue;
      def.params = { ...(def.params ?? {}), [r.name]: { type: 'string', required: true } };
      declared.push(r.name);
    }
  }
  return declared;
}

export interface PreviewServer {
  name: string;
  /** Path relative to the registry root. */
  path: string;
  /** Repository id for a repository-only server; undefined for a shared one. */
  repo?: string;
  def: ServerDef;
  yaml: string;
  exists: boolean;
  /** Environment variables the user must export for secrets. */
  envVars: string[];
  problems: Problem[];
}

export interface AddPreview {
  servers: PreviewServer[];
  notes: string[];
}

export function previewAdd(
  registry: Registry,
  entries: AddEntry[],
  opts: { name?: string; description?: string; root?: string; repo?: string } = {},
): AddPreview {
  if (opts.name && entries.length > 1) throw new LoadoutError('A name can only be given when adding a single server');
  const notes: string[] = [];
  const servers: PreviewServer[] = [];
  for (const entry of entries) {
    const rawName = opts.name || entry.name;
    if (!rawName) throw new LoadoutError('This config has no server name: give it a name');
    const { def, notes: n } = convertEntry(rawName, entry.cfg, opts.root);
    const placeholders = declarePlaceholders(def);
    if (opts.description) def.description = opts.description;
    else if (typeof entry.cfg.description === 'string') def.description = entry.cfg.description;
    notes.push(...n);
    if (servers.some((s) => s.name === def.name)) throw new LoadoutError(`Server "${def.name}" appears twice`);
    const ordered: ServerDef = {
      name: def.name,
      ...(def.description ? { description: def.description } : {}),
      transport: def.transport,
    };
    if (def.params) ordered.params = def.params;
    const file = serverPath(registry, def.name, opts.repo);
    const path = relative(registry.root, file).split(sep).join('/');
    const problems = checkServer(ordered, path, def.name);
    if (placeholders.length && opts.repo) {
      problems.push({
        level: 'error',
        file: path,
        message: `{{ params.${placeholders[0]} }}: a repository-only server has no per-repository values — write the value directly`,
      });
    } else if (placeholders.length) {
      notes.push(`${def.name}: ${placeholders.join(', ')} — set per repository (required)`);
    }
    if (opts.repo && registry.bindings.get(opts.repo)?.some((b) => b.server === def.name)) {
      problems.push({
        level: 'error',
        file: path,
        message: `${opts.repo} already uses the shared server "${def.name}"; pick another name`,
      });
    }
    servers.push({
      name: def.name,
      path,
      repo: opts.repo,
      def: ordered,
      yaml: serverFileContent(registry, file, ordered),
      exists:
        existsSync(file) || (opts.repo ? !!registry.repoServers.get(opts.repo)?.has(def.name) : registry.servers.has(def.name)),
      envVars: Object.values(def.params ?? {}).flatMap((p) =>
        typeof p.default === 'string' ? [p.default.replace(/^env:\/\//, '')] : [],
      ),
      problems,
    });
  }
  return { servers, notes };
}

/** Write previewed servers. Refuses on validation errors, or on existing servers unless overwrite. */
export function commitAdd(registry: Registry, preview: AddPreview, opts: { overwrite?: boolean } = {}): string[] {
  for (const s of preview.servers) {
    const errors = s.problems.filter((p) => p.level === 'error');
    if (errors.length) throw new LoadoutError(`${s.name}: ${errors.map((e) => e.message).join('; ')}`);
    if (s.exists && !opts.overwrite) throw new LoadoutError(`Server "${s.name}" already exists (overwrite to replace it)`);
  }
  for (const s of preview.servers) {
    const file = join(registry.root, s.path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, s.yaml);
  }
  return preview.servers.map((s) => s.name);
}

function moveFile(registry: Registry, from: string, to: string) {
  const text = readFileSync(from, 'utf8').replace(/^# yaml-language-server:.*\n/, '');
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, schemaHeader(registry, to) + text);
  rmSync(from);
  pruneEmptyDirs(registry, dirname(from));
}

/** Remove now-empty repos/<host>/<owner>/<name>/ directories (and repos/ itself). */
function pruneEmptyDirs(registry: Registry, dir: string) {
  const stop = join(registry.root, 'repos');
  while (dir === stop || dir.startsWith(stop + sep)) {
    try {
      rmdirSync(dir);
    } catch {
      return;
    }
    dir = dirname(dir);
  }
}

/** Turn a repository-only server into a shared one, keeping it attached to that repository. */
export function shareServer(registry: Registry, repo: string, rawName: string) {
  const name = normalizeServerName(rawName);
  const from = serverPath(registry, name, repo);
  if (!existsSync(from)) throw new LoadoutError(`${repo} has no repository-only server "${name}"`);
  if (registry.servers.has(name) || existsSync(serverPath(registry, name))) {
    throw new LoadoutError(`A shared server named "${name}" already exists`);
  }
  moveFile(registry, from, serverPath(registry, name));
  attachServers(registry.bindingsPath, repo, [name]);
}

/** Turn a shared server used by at most one repository into that repository's own server. */
export function makeRepoOnly(registry: Registry, rawName: string, repo?: string): string {
  const name = normalizeServerName(rawName);
  if (!registry.servers.has(name)) throw new LoadoutError(`No shared server named "${name}"`);
  const users = usersOf(registry, name);
  if (users.length > 1)
    throw new LoadoutError(`"${name}" is used by ${users.length} repositories (${users.join(', ')}); it must stay shared`);
  const target = repo ?? users[0];
  if (!target) throw new LoadoutError(`"${name}" is not attached anywhere; say which repository it belongs to`);
  if (users[0] && users[0] !== target) throw new LoadoutError(`"${name}" is used by ${users[0]}, not ${target}`);
  const to = serverPath(registry, name, target);
  if (existsSync(to)) throw new LoadoutError(`${target} already has its own "${name}"`);
  moveFile(registry, serverPath(registry, name), to);
  detachServers(registry.bindingsPath, target, [name]);
  return target;
}

export function usersOf(registry: Registry, name: string): string[] {
  return [...registry.bindings].filter(([, bs]) => bs.some((b) => b.server === name)).map(([id]) => id);
}

/** Delete a shared server no repository uses, or a repository-only server (with `repo`). */
export function removeServer(registry: Registry, rawName: string, repo?: string) {
  const name = normalizeServerName(rawName);
  if (repo) {
    const file = serverPath(registry, name, repo);
    if (!existsSync(file)) throw new LoadoutError(`${repo} has no repository-only server "${name}"`);
    rmSync(file);
    pruneEmptyDirs(registry, dirname(file));
    return;
  }
  const users = usersOf(registry, name);
  if (users.length) throw new LoadoutError(`"${name}" is still used by: ${users.join(', ')}. Detach it first.`);
  const file = serverPath(registry, name);
  if (!existsSync(file)) throw new LoadoutError(`No shared server named "${name}"`);
  rmSync(file);
}

export function readServerSource(registry: Registry, rawName: string, repo?: string): { path: string; yaml: string } {
  const file = serverPath(registry, normalizeServerName(rawName), repo);
  if (!existsSync(file)) throw new LoadoutError(`No such server: ${relative(registry.root, file)}`);
  return { path: relative(registry.root, file).split(sep).join('/'), yaml: readFileSync(file, 'utf8') };
}

/**
 * Replace a server definition with edited YAML. The registry is re-validated with the new file in place;
 * if that introduces errors (bad schema, a repository now missing a required param, …) the old file is restored.
 */
export function writeServerSource(registry: Registry, rawName: string, yaml: string, repo?: string): Problem[] {
  const name = normalizeServerName(rawName);
  const file = serverPath(registry, name, repo);
  if (!existsSync(file)) throw new LoadoutError(`No such server: ${relative(registry.root, file)}`);
  let data: unknown;
  try {
    data = YAML.parse(yaml);
  } catch (e) {
    throw new LoadoutError(`Invalid YAML: ${(e as Error).message}`);
  }
  const path = relative(registry.root, file).split(sep).join('/');
  const own = checkServer(data, path, name).filter((p) => p.level === 'error');
  if (own.length) throw new LoadoutError(own.map((p) => p.message).join('\n'));
  const key = (p: Problem) => `${p.file}\0${p.message}`;
  const before = new Set(
    loadRegistry(registry.root)
      .problems.filter((p) => p.level === 'error')
      .map(key),
  );
  const previous = readFileSync(file, 'utf8');
  writeFileSync(file, yaml.endsWith('\n') ? yaml : `${yaml}\n`);
  const after = loadRegistry(registry.root).problems;
  const introduced = after.filter((p) => p.level === 'error' && !before.has(key(p)));
  if (introduced.length) {
    writeFileSync(file, previous);
    throw new LoadoutError(introduced.map((p) => `${p.file}: ${p.message}`).join('\n'));
  }
  return after.filter((p) => p.level === 'warning' && p.file === path);
}
