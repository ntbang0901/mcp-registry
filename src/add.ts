import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { LoadoutError } from './errors.js';
import { convertEntry, normalizeServerName, SERVER_HEADER } from './importer.js';
import { checkServer, SERVERS_DIR, type Problem, type Registry } from './registry.js';
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

/** Split a command line, honoring single/double quotes and backslash escapes. */
export function splitCommandLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
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
    return { name: form.name, cfg: { type: 'http', url: form.url.trim(), ...(Object.keys(pairs).length ? { headers: pairs } : {}) } };
  }
  const [command, ...args] = splitCommandLine(form.command ?? '');
  if (!command) throw new LoadoutError('Command is required');
  return { name: form.name, cfg: { command, args, ...(Object.keys(pairs).length ? { env: pairs } : {}) } };
}

export interface PreviewServer {
  name: string;
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
  opts: { name?: string; description?: string; root?: string } = {},
): AddPreview {
  if (opts.name && entries.length > 1) throw new LoadoutError('A name can only be given when adding a single server');
  const notes: string[] = [];
  const servers: PreviewServer[] = [];
  for (const entry of entries) {
    const rawName = opts.name || entry.name;
    if (!rawName) throw new LoadoutError('This config has no server name: give it a name');
    const { def, notes: n } = convertEntry(rawName, entry.cfg, opts.root);
    if (opts.description) def.description = opts.description;
    else if (typeof entry.cfg.description === 'string') def.description = entry.cfg.description;
    notes.push(...n);
    if (servers.some((s) => s.name === def.name)) throw new LoadoutError(`Server "${def.name}" appears twice`);
    const ordered: ServerDef = { name: def.name, ...(def.description ? { description: def.description } : {}), transport: def.transport };
    if (def.params) ordered.params = def.params;
    servers.push({
      name: def.name,
      def: ordered,
      yaml: SERVER_HEADER + YAML.stringify(ordered),
      exists: registry.servers.has(def.name) || existsSync(serverPath(registry, def.name)),
      envVars: Object.values(def.params ?? {}).flatMap((p) => (typeof p.default === 'string' ? [p.default.replace(/^env:\/\//, '')] : [])),
      problems: checkServer(ordered, `${SERVERS_DIR}/${def.name}.yaml`, def.name),
    });
  }
  return { servers, notes };
}

export const serverPath = (registry: Registry, name: string) => join(registry.root, SERVERS_DIR, `${name}.yaml`);

/** Write previewed servers. Refuses on validation errors, or on existing servers unless overwrite. */
export function commitAdd(registry: Registry, preview: AddPreview, opts: { overwrite?: boolean } = {}): string[] {
  for (const s of preview.servers) {
    const errors = s.problems.filter((p) => p.level === 'error');
    if (errors.length) throw new LoadoutError(`${s.name}: ${errors.map((e) => e.message).join('; ')}`);
    if (s.exists && !opts.overwrite) throw new LoadoutError(`Server "${s.name}" already exists (overwrite to replace it)`);
  }
  mkdirSync(join(registry.root, SERVERS_DIR), { recursive: true });
  for (const s of preview.servers) writeFileSync(serverPath(registry, s.name), s.yaml);
  return preview.servers.map((s) => s.name);
}

/** Delete a server definition that no repository uses. */
export function removeServer(registry: Registry, rawName: string) {
  const name = normalizeServerName(rawName);
  const users = [...registry.bindings].filter(([, bs]) => bs.some((b) => b.server === name)).map(([id]) => id);
  if (users.length) throw new LoadoutError(`"${name}" is still used by: ${users.join(', ')}. Detach it first.`);
  const file = serverPath(registry, name);
  if (!existsSync(file)) throw new LoadoutError(`No server named "${name}"`);
  rmSync(file);
}
