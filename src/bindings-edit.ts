import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import YAML, { isMap, isScalar, isSeq, YAMLMap, YAMLSeq, type Document } from 'yaml';
import { LoadoutError } from './errors.js';
import { normalizeRepoId } from './repo.js';

export const BINDINGS_HEADER = '# yaml-language-server: $schema=./schemas/bindings.schema.json\n';

const STRINGIFY = { flowCollectionPadding: false } as const;

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
