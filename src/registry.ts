import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import YAML from 'yaml';
import { LoadoutError } from './errors.js';
import { normalizeRepoId, repoContext } from './repo.js';
import { parseSecretRef, resolveServer } from './resolve.js';
import { templateRefs } from './template.js';
import type { Binding, ParamValue, ServerDef } from './types.js';

export interface Problem {
  level: 'error' | 'warning';
  file: string;
  message: string;
}

export interface Registry {
  root: string;
  /** Shared servers (servers/*.yaml), attachable to any repository via bindings.yaml. */
  servers: Map<string, ServerDef>;
  /** Repository-only servers (repos/<host>/<owner>/<name>/*.yaml): always active for that repository only. */
  repoServers: Map<string, Map<string, ServerDef>>;
  /** Normalized repository id -> bindings, in declaration order. */
  bindings: Map<string, Binding[]>;
  bindingsPath: string;
}

export const BINDINGS_FILE = 'bindings.yaml';
export const SERVERS_DIR = 'servers';
export const REPOS_DIR = 'repos';

/** Directory holding a repository's own servers. */
export const repoServersDir = (root: string, id: string) => join(root, REPOS_DIR, ...id.split('/'));

/** Every repository the registry knows: listed in bindings.yaml or owning repo-only servers. */
export function knownRepos(registry: Registry): string[] {
  return [...new Set([...registry.bindings.keys(), ...registry.repoServers.keys()])];
}

/** Names that usually hold credentials (env vars, headers, query params, CLI flags). */
export const SECRET_NAME = /(api[_-]?key|apikey|token|secret|passw(or)?d|credential|authorization|private[_-]?key)/i;

let validators: { server: ValidateFunction; bindings: ValidateFunction } | undefined;
function getValidators() {
  if (!validators) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    const load = (f: string) => JSON.parse(readFileSync(new URL(`../schemas/${f}`, import.meta.url), 'utf8'));
    validators = {
      server: ajv.compile(load('server.schema.json')),
      bindings: ajv.compile(load('bindings.schema.json')),
    };
  }
  return validators;
}

function schemaMessages(errors: ErrorObject[] | null | undefined): string[] {
  // oneOf failures are noisy; keep the most specific messages.
  const relevant = (errors ?? []).filter((e) => e.keyword !== 'oneOf' && e.keyword !== 'not' && e.keyword !== 'if');
  const list = relevant.length ? relevant : (errors ?? []);
  return [...new Set(list.map((e) => `${e.instancePath || '/'} ${e.message}${e.keyword === 'additionalProperties' ? `: ${(e.params as { additionalProperty: string }).additionalProperty}` : ''}`))];
}

function parseYaml(file: string, problems: Problem[]): unknown {
  try {
    return YAML.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    problems.push({ level: 'error', file, message: `invalid YAML: ${(e as Error).message}` });
    return undefined;
  }
}

function lintServer(def: ServerDef, file: string, problems: Problem[]) {
  const err = (message: string) => problems.push({ level: 'error', file, message });
  const warn = (message: string) => problems.push({ level: 'warning', file, message });
  const params = def.params ?? {};
  const t = def.transport;
  const templates: Array<[string, string]> = [];
  if (t.type === 'http') {
    templates.push(['url', t.url]);
    for (const [k, v] of Object.entries(t.headers ?? {})) templates.push([`headers.${k}`, v]);
  } else {
    if (t.command) templates.push(['command', t.command]);
    (t.args ?? []).forEach((a, i) => templates.push([`args[${i}]`, a]));
    for (const [k, v] of Object.entries(t.env ?? {})) templates.push([`env.${k}`, v]);
  }
  const used = new Set<string>();
  for (const [where, tpl] of templates) {
    try {
      for (const r of templateRefs(tpl)) {
        if (r.scope !== 'params') continue;
        used.add(r.name);
        if (!(r.name in params)) err(`${where} references undeclared param "${r.name}"`);
      }
    } catch (e) {
      err(`${where}: ${(e as Error).message}`);
    }
  }
  for (const [name, spec] of Object.entries(params)) {
    if (!used.has(name)) warn(`param "${name}" is declared but never used`);
    if (spec.type === 'secret' && spec.default !== undefined) {
      try {
        if (typeof spec.default !== 'string') throw new Error('must be a string');
        parseSecretRef(spec.default);
      } catch (e) {
        err(`param "${name}" default: ${(e as Error).message}`);
      }
    }
  }
  // Plaintext secrets must never live in the registry.
  const hasParam = (v: string) => /\{\{\s*params\./.test(v);
  const secretEntries =
    t.type === 'http' ? Object.entries(t.headers ?? {}).map(([k, v]) => [`headers.${k}`, k, v]) : Object.entries(t.env ?? {}).map(([k, v]) => [`env.${k}`, k, v]);
  for (const [where, key, value] of secretEntries) {
    if (SECRET_NAME.test(key) && value && !hasParam(value)) err(`${where} looks like a plaintext secret; use a secret param`);
  }
  if (t.type === 'http') {
    const query = t.url.split('?')[1]?.split('#')[0] ?? '';
    for (const pair of query.split('&').filter(Boolean)) {
      const [k, v = ''] = pair.split('=');
      if (SECRET_NAME.test(k) && !hasParam(v)) err(`url query "${k}" looks like a plaintext secret; use a secret param`);
    }
  } else if (t.command && /^(npx|uvx|bunx|pipx)$/.test(t.command)) {
    warn(`command "${t.command}" runs an unpinned package; use transport.package with an exact version`);
  }
}

/**
 * Validate one server definition (schema + lint). `expectedName` is the file name it will be stored under.
 */
export function checkServer(data: unknown, file: string, expectedName?: string): Problem[] {
  const problems: Problem[] = [];
  const validate = getValidators().server;
  if (!validate(data)) {
    for (const m of schemaMessages(validate.errors)) problems.push({ level: 'error', file, message: m });
    return problems;
  }
  const def = data as ServerDef;
  if (expectedName !== undefined && def.name !== expectedName) {
    problems.push({ level: 'error', file, message: `name "${def.name}" must match the file name "${expectedName}"` });
    return problems;
  }
  lintServer(def, file, problems);
  return problems;
}

export function loadRegistry(root: string): { registry: Registry; problems: Problem[] } {
  const problems: Problem[] = [];
  const { bindings: validateBindings } = getValidators();
  const rel = (f: string) => relative(root, f) || f;

  const servers = new Map<string, ServerDef>();
  const serversDir = join(root, SERVERS_DIR);
  if (!existsSync(serversDir)) {
    problems.push({ level: 'error', file: SERVERS_DIR, message: 'directory not found — is this a loadout registry?' });
  } else {
    for (const f of readdirSync(serversDir).sort()) {
      if (!/\.ya?ml$/.test(f)) continue;
      const file = join(serversDir, f);
      const data = parseYaml(file, problems);
      if (data === undefined) continue;
      const expected = basename(f).replace(/\.ya?ml$/, '');
      problems.push(...checkServer(data, rel(file), expected));
      const def = data as ServerDef;
      if (!getValidators().server(data) || def.name !== expected) continue;
      servers.set(def.name, def);
    }
  }

  const repoServers = loadRepoServers(root, problems);

  const bindingsPath = join(root, BINDINGS_FILE);
  const bindings = new Map<string, Binding[]>();
  if (existsSync(bindingsPath)) {
    const data = parseYaml(bindingsPath, problems);
    if (data !== undefined && !validateBindings(data ?? {})) {
      for (const m of schemaMessages(validateBindings.errors)) problems.push({ level: 'error', file: BINDINGS_FILE, message: m });
    } else if (data) {
      const repos = (data as { repositories: Record<string, unknown> | null }).repositories ?? {};
      for (const [key, value] of Object.entries(repos)) {
        let id: string;
        try {
          id = normalizeRepoId(key);
        } catch (e) {
          problems.push({ level: 'error', file: BINDINGS_FILE, message: (e as Error).message });
          continue;
        }
        if (bindings.has(id)) {
          problems.push({ level: 'error', file: BINDINGS_FILE, message: `repository "${id}" is listed more than once` });
          continue;
        }
        const list: Binding[] = Array.isArray(value)
          ? value.map((server: string) => ({ server, params: {} }))
          : Object.entries((value ?? {}) as Record<string, { params?: Record<string, ParamValue> } | null>).map(
              ([server, b]) => ({ server, params: b?.params ?? {} }),
            );
        const seen = new Set<string>();
        const ctx = repoContext(id, `/path/to/${id.split('/').pop()}`);
        for (const b of list) {
          const where = `${id} → ${b.server}`;
          if (seen.has(b.server)) problems.push({ level: 'error', file: BINDINGS_FILE, message: `${where}: listed twice` });
          seen.add(b.server);
          const def = servers.get(b.server);
          if (!def) {
            problems.push({ level: 'error', file: BINDINGS_FILE, message: `${where}: unknown server (no ${SERVERS_DIR}/${b.server}.yaml)` });
            continue;
          }
          if (def.status === 'deprecated') problems.push({ level: 'warning', file: BINDINGS_FILE, message: `${where}: server is deprecated` });
          try {
            resolveServer(def, b, ctx);
          } catch (e) {
            problems.push({ level: 'error', file: BINDINGS_FILE, message: `${where}: ${(e as Error).message}` });
          }
        }
        for (const b of list) {
          if (repoServers.get(id)?.has(b.server)) {
            problems.push({
              level: 'error',
              file: BINDINGS_FILE,
              message: `${id} → ${b.server}: clashes with the repository's own ${REPOS_DIR}/${id}/${b.server}.yaml`,
            });
          }
        }
        bindings.set(id, list);
      }
    }
  }
  return { registry: { root, servers, repoServers, bindings, bindingsPath }, problems };
}

function loadRepoServers(root: string, problems: Problem[]): Map<string, Map<string, ServerDef>> {
  const out = new Map<string, Map<string, ServerDef>>();
  const base = join(root, REPOS_DIR);
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.ya?ml$/.test(e.name)) continue;
      const relDir = relative(base, dir).split(sep).join('/');
      const file = relative(root, full);
      let id: string;
      try {
        id = normalizeRepoId(relDir);
      } catch {
        problems.push({ level: 'error', file, message: `must be inside ${REPOS_DIR}/<host>/<owner>/<name>/` });
        continue;
      }
      if (id !== relDir) {
        problems.push({ level: 'error', file, message: `directory must be the normalized repository id: ${REPOS_DIR}/${id}/` });
        continue;
      }
      const data = parseYaml(full, problems);
      if (data === undefined) continue;
      const expected = e.name.replace(/\.ya?ml$/, '');
      problems.push(...checkServer(data, file, expected));
      const def = data as ServerDef;
      if (!getValidators().server(data) || def.name !== expected) continue;
      try {
        resolveServer(def, { server: def.name, params: {} }, repoContext(id, `/path/to/${id.split('/').pop()}`));
      } catch (err) {
        problems.push({ level: 'error', file, message: (err as Error).message });
      }
      if (!out.has(id)) out.set(id, new Map());
      out.get(id)!.set(def.name, def);
    }
  };
  if (existsSync(base)) walk(base);
  return out;
}

/** File of a shared server, or of a repository-only server when `repo` is given. */
export const serverPath = (registry: Registry, name: string, repo?: string) =>
  join(repo ? repoServersDir(registry.root, repo) : join(registry.root, SERVERS_DIR), `${name}.yaml`);

export function schemaHeader(registry: Registry, file: string): string {
  const schema = relative(dirname(file), join(registry.root, 'schemas', 'server.schema.json')).split(sep).join('/');
  return `# yaml-language-server: $schema=${schema}\n`;
}

export function serverFileContent(registry: Registry, file: string, def: ServerDef): string {
  return schemaHeader(registry, file) + YAML.stringify(def);
}

export function formatProblems(problems: Problem[]): string {
  return problems.map((p) => `  ${p.level === 'error' ? 'error  ' : 'warning'} ${p.file}: ${p.message}`).join('\n');
}

/** Load the registry and fail if it has errors (warnings are returned for display). */
export function loadValidRegistry(root: string): { registry: Registry; warnings: Problem[] } {
  const { registry, problems } = loadRegistry(root);
  const errors = problems.filter((p) => p.level === 'error');
  if (errors.length) {
    throw new LoadoutError(`Registry at ${root} is invalid:\n${formatProblems(errors)}\nRun "loadout validate" for details.`);
  }
  return { registry, warnings: problems.filter((p) => p.level === 'warning') };
}
