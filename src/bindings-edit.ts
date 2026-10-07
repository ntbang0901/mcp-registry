import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import YAML, { isMap, isScalar, isSeq, YAMLMap, YAMLSeq, type Document } from 'yaml';
import { LoadoutError } from './errors.js';
import type { ParamValue } from './types.js';
import { normalizeRepoId } from './repo.js';

export const BINDINGS_HEADER = '# yaml-language-server: $schema=./schemas/bindings.schema.json\n';

const STRINGIFY = { flowCollectionPadding: false, nullStr: '' } as const;

function loadDoc(path: string): Document {
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const text = existing.trim() ? existing : `${BINDINGS_HEADER}repositories: {}\n`;
  const doc: Document = YAML.parseDocument(text);
  if (doc.errors.length) throw new LoadoutError(`${path}: ${doc.errors[0].message}`);
  if (!isMap(doc.contents)) throw new LoadoutError(`${path}: top level must be a mapping with "repositories"`);
  let repos = doc.get('repositories');
  if (!isMap(repos)) {
    repos = new YAMLMap();
    doc.set('repositories', repos);
  }
  // `repositories: {}` is a flow map; keep one repository per line once entries are added.
  (repos as YAMLMap).flow = false;
  return doc;
}

function findRepoPair(repos: YAMLMap, id: string) {
  return repos.items.find((pair) => {
    const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
    try {
      return normalizeRepoId(key) === id;
    } catch {
      return false;
    }
  });
}

function serverNames(value: unknown): string[] {
  if (isSeq(value)) return value.items.map((i) => String(isScalar(i) ? i.value : i));
  if (isMap(value)) return value.items.map((p) => String(isScalar(p.key) ? p.key.value : p.key));
  return [];
}

/**
 * Add servers to a repository in bindings.yaml, preserving comments and formatting.
 * Returns the servers that were actually added.
 */
export function attachServers(path: string, id: string, servers: string[]): string[] {
  const doc = loadDoc(path);
  const repos = doc.get('repositories') as YAMLMap;
  let pair = findRepoPair(repos, id);
  const created = !pair;
  if (!pair) {
    const seq = new YAMLSeq();
    seq.flow = true;
    repos.set(id, seq);
    pair = findRepoPair(repos, id)!;
  }
  const existing = new Set(serverNames(pair.value));
  const added = servers.filter((s, i) => !existing.has(s) && servers.indexOf(s) === i);
  if (isMap(pair.value)) {
    for (const s of added) pair.value.set(s, null);
  } else {
    if (!isSeq(pair.value)) {
      const seq = new YAMLSeq();
      seq.flow = true;
      pair.value = seq;
    }
    for (const s of added) (pair.value as YAMLSeq).add(s);
  }
  if (added.length || created) writeFileSync(path, doc.toString(STRINGIFY));
  return added;
}

/** Remove servers from a repository. The repository stays listed (possibly with []), so sync cleans up. */
export function detachServers(path: string, id: string, servers: string[]): string[] {
  const doc = loadDoc(path);
  const repos = doc.get('repositories') as YAMLMap;
  const pair = findRepoPair(repos, id);
  if (!pair) return [];
  const existing = serverNames(pair.value);
  const removed = servers.filter((s) => existing.includes(s));
  if (isMap(pair.value)) {
    for (const s of removed) pair.value.delete(s);
  } else if (isSeq(pair.value)) {
    pair.value.items = pair.value.items.filter((i) => !removed.includes(String(isScalar(i) ? i.value : i)));
  }
  if (removed.length) writeFileSync(path, doc.toString(STRINGIFY));
  return removed;
}

/**
 * Set the params of one server binding (replacing previous values). The repository entry switches to the
 * map form while any server has params, and back to the compact list form when none has.
 */
export function setBindingParams(path: string, id: string, server: string, params: Record<string, ParamValue>): void {
  const doc = loadDoc(path);
  const repos = doc.get('repositories') as YAMLMap;
  const pair = findRepoPair(repos, id);
  if (!pair) throw new LoadoutError(`${id} is not in bindings.yaml`);
  const current = new Map<string, Record<string, ParamValue>>();
  if (isMap(pair.value)) {
    for (const item of pair.value.items) {
      const name = String(isScalar(item.key) ? item.key.value : item.key);
      const value = (item.value as { toJSON?: () => unknown } | null)?.toJSON?.() as {
        params?: Record<string, ParamValue>;
      } | null;
      current.set(name, value?.params ?? {});
    }
  } else {
    for (const name of serverNames(pair.value)) current.set(name, {});
  }
  if (!current.has(server)) throw new LoadoutError(`${server} is not attached to ${id}`);
  current.set(server, params);
  // Keep an end-of-line comment ("repo: [a, b] # note"): on the key in map form, on the list otherwise.
  const key = pair.key as { comment?: string };
  const comment = (pair.value as { comment?: string } | null)?.comment ?? key.comment;
  key.comment = undefined;
  let next: YAMLMap | YAMLSeq;
  if ([...current.values()].every((p) => Object.keys(p).length === 0)) {
    next = new YAMLSeq();
    next.flow = true;
    for (const name of current.keys()) next.add(name);
  } else {
    next = new YAMLMap();
    for (const [name, p] of current) next.set(name, Object.keys(p).length ? doc.createNode({ params: p }) : null);
  }
  if (comment && isMap(next)) key.comment = comment;
  else if (comment) next.comment = comment;
  pair.value = next;
  writeFileSync(path, doc.toString(STRINGIFY));
}
