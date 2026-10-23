import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ADAPTERS, type AdapterId } from './adapters/index.js';
import { attachServers, USER_SCOPE } from './bindings-edit.js';
import { LoadoutError } from './errors.js';
import { comparable, convertEntry } from './importer.js';
import { serverFileContent, serverPath, USER_CONTEXT, type Registry } from './registry.js';
import { resolveServer, secretEnvNames } from './resolve.js';
import type { ResolvedServer, ServerDef } from './types.js';
import type { State } from './writer.js';

/** Home directory holding the user-scope client configs ($LOADOUT_HOME overrides it, for tests). */
export function userHome(): string {
  return process.env.LOADOUT_HOME ? resolve(process.env.LOADOUT_HOME) : homedir();
}

export const userFile = (target: AdapterId) => join(userHome(), ADAPTERS[target].userPath);

/** Servers in user scope (`user:` in bindings.yaml), resolved. */
export function resolveUser(registry: Registry): ResolvedServer[] {
  return registry.userBindings.map((b) => {
    try {
      return resolveServer(registry.servers.get(b.server)!, b, USER_CONTEXT);
    } catch (e) {
      throw new LoadoutError(`user → ${b.server}: ${(e as Error).message}`);
    }
  });
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function readJson(file: string): Json | undefined {
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, 'utf8');
  if (!text.trim()) return {};
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new LoadoutError(`${file} is not valid JSON (${(e as Error).message}); fix it before loadout edits it`);
  }
  if (!isObject(data)) throw new LoadoutError(`${file}: expected a JSON object`);
  if (data.mcpServers !== undefined && !isObject(data.mcpServers))
    throw new LoadoutError(`${file}: "mcpServers" is not an object`);
  return data;
}

/** Write next to the file, then rename: a client reading it never sees half a file. */
function writeJsonAtomic(file: string, data: Json) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.loadout-${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, file);
}

export type EntryOutcome =
  | 'added'
  | 'updated'
  | 'unchanged'
  | 'replaced' // hand-written entry overwritten with --force (backup kept)
  | 'conflict' // hand-written entry with the same name, not touched
  | 'removed'
  | 'kept'; // was loadout's, edited by hand since, no longer wanted: left alone

export interface UserFileResult {
  target: AdapterId;
  path: string;
  entries: Array<{ name: string; outcome: EntryOutcome }>;
  /** Other entries, which loadout does not manage (added by hand or by the client itself). */
  unmanaged: string[];
  backup?: string;
}

export interface UserSyncResult {
  servers: string[];
  files: UserFileResult[];
  envVars: string[];
  missingEnv: string[];
}

/**
 * Merge the user-scope servers into each client's user config. Only `mcpServers` entries loadout wrote
 * are changed or removed; every other entry and setting in the file is kept as it is.
 */
export function syncUser(
  registry: Registry,
  targets: AdapterId[],
  state: State,
  opts: { force?: boolean; dryRun?: boolean } = {},
): UserSyncResult {
  const servers = resolveUser(registry);
  const files = targets.map((target) => syncUserFile(target, servers, state, opts));
  const envVars = [...new Set(servers.flatMap(secretEnvNames))].sort();
  return { servers: servers.map((s) => s.name), files, envVars, missingEnv: envVars.filter((n) => !process.env[n]) };
}

function syncUserFile(
  target: AdapterId,
  servers: ResolvedServer[],
  state: State,
  opts: { force?: boolean; dryRun?: boolean },
): UserFileResult {
  const file = userFile(target);
  const desired = ADAPTERS[target].entries(servers);
  const data = readJson(file) ?? {};
  const current: Json = { ...((data.mcpServers as Json | undefined) ?? {}) };
  const entries: UserFileResult['entries'] = [];
  let changed = false;
  let replaced = false;
  const record: Array<() => void> = [];
  for (const [name, entry] of Object.entries(desired)) {
    const cur = current[name];
    let outcome: EntryOutcome;
    if (cur === undefined) outcome = 'added';
    else if (same(cur, entry)) outcome = 'unchanged';
    else if (state.ownsEntry(file, name, cur)) outcome = 'updated';
    else if (opts.force) outcome = 'replaced';
    else outcome = 'conflict';
    if (outcome !== 'conflict') {
      if (outcome !== 'unchanged') changed = true;
      if (outcome === 'replaced') replaced = true;
      current[name] = entry;
      record.push(() => state.recordEntry(file, name, entry));
    }
    entries.push({ name, outcome });
  }
  for (const name of state.ownedEntries(file)) {
    if (name in desired) continue;
    const cur = current[name];
    if (cur !== undefined && state.ownsEntry(file, name, cur)) {
      delete current[name];
      changed = true;
      entries.push({ name, outcome: 'removed' });
    } else if (cur !== undefined) {
      entries.push({ name, outcome: 'kept' });
    }
    record.push(() => state.forgetEntry(file, name));
  }
  const listed = new Set(entries.map((e) => e.name));
  const unmanaged = Object.keys(current).filter((n) => !listed.has(n));
  const result: UserFileResult = { target, path: file, entries, unmanaged };
  if (opts.dryRun) return result;
  if (changed) {
    if (replaced) {
      result.backup = `${file}.bak`;
      copyFileSync(file, result.backup);
    }
    writeJsonAtomic(file, { ...data, mcpServers: current });
  }
  for (const r of record) r();
  return result;
}

export type UserEntryStatus = 'ok' | 'missing' | 'stale' | 'modified' | 'orphan';

export interface UserStatus {
  target: AdapterId;
  path: string;
  entries: Array<{ name: string; status: UserEntryStatus }>;
  unmanaged: string[];
}

/** What `syncUser` would change, entry by entry, without writing. */
export function userStatus(registry: Registry, targets: AdapterId[], state: State): UserStatus[] {
  const servers = resolveUser(registry);
  return targets.map((target) => {
    const file = userFile(target);
    const desired = ADAPTERS[target].entries(servers);
    const current = ((readJson(file) ?? {}).mcpServers as Json | undefined) ?? {};
    const entries: UserStatus['entries'] = Object.entries(desired).map(([name, entry]) => {
      const cur = current[name];
      const status: UserEntryStatus =
        cur === undefined ? 'missing' : same(cur, entry) ? 'ok' : state.ownsEntry(file, name, cur) ? 'stale' : 'modified';
      return { name, status };
    });
    for (const name of state.ownedEntries(file)) {
      if (!(name in desired) && current[name] !== undefined && state.ownsEntry(file, name, current[name]))
        entries.push({ name, status: 'orphan' });
    }
    const listed = new Set(entries.map((e) => e.name));
    const unmanaged = Object.keys(current).filter((n) => !listed.has(n) && !state.ownsEntry(file, n, current[n]));
    return { target, path: file, entries, unmanaged };
  });
}

export interface UserImportResult {
  sources: string[];
  created: string[];
  reused: string[];
  /** Same name as a different shared server already in use: not imported. */
  skipped: string[];
  added: string[];
  notes: string[];
}

/**
 * Bring the hand-written entries of the user-scope client configs under loadout: each becomes a shared
 * server (or reuses an identical one) and is added to user scope. Secrets are replaced by env:// refs.
 */
export function importUser(
  registry: Registry,
  targets: AdapterId[],
  state: State,
  opts: { dryRun?: boolean } = {},
): UserImportResult {
  const result: UserImportResult = { sources: [], created: [], reused: [], skipped: [], added: [], notes: [] };
  const found = new Map<string, ServerDef>();
  for (const target of targets) {
    const file = userFile(target);
    const current = ((readJson(file) ?? {}).mcpServers as Record<string, Json> | undefined) ?? {};
    const handWritten = Object.entries(current).filter(([name, cfg]) => !state.ownsEntry(file, name, cfg));
    if (!handWritten.length) continue;
    result.sources.push(file);
    for (const [rawName, cfg] of handWritten) {
      if (!isObject(cfg)) continue;
      let def: ServerDef;
      try {
        const converted = convertEntry(rawName, cfg);
        def = converted.def;
        if (!found.has(def.name)) result.notes.push(...converted.notes);
      } catch (e) {
        result.notes.push(`${rawName} (${file}): ${(e as Error).message}`);
        continue;
      }
      const previous = found.get(def.name);
      if (previous) {
        if (comparable(previous) !== comparable(def))
          result.notes.push(`${def.name}: differs between client files; using the first`);
        continue;
      }
      def.description = 'Imported from user-scope client config';
      found.set(def.name, def);
    }
  }
  const inUse = (name: string) =>
    registry.userBindings.some((b) => b.server === name) ||
    [...registry.bindings.values()].some((bs) => bs.some((b) => b.server === name));
  for (const def of found.values()) {
    const existing = registry.servers.get(def.name);
    if (existing && comparable(existing) === comparable(def)) {
      result.reused.push(def.name);
    } else if (existing && inUse(def.name)) {
      result.skipped.push(def.name);
      result.notes.push(
        `${def.name}: a different shared server with this name is already in use; rename the entry in your client config and import again`,
      );
      continue;
    } else {
      result.created.push(def.name);
      if (!opts.dryRun) {
        const file = serverPath(registry, def.name);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, serverFileContent(registry, file, def));
      }
    }
    if (!registry.userBindings.some((b) => b.server === def.name)) result.added.push(def.name);
  }
  if (!opts.dryRun && result.added.length) attachServers(registry.bindingsPath, USER_SCOPE, result.added);
  return result;
}
