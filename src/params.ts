import { attachServers, setBindingParams } from './bindings-edit.js';
import { LoadoutError } from './errors.js';
import type { Registry } from './registry.js';
import { repoContext } from './repo.js';
import { resolveParams } from './resolve.js';
import type { ParamSpec, ParamValue, ServerDef } from './types.js';

/** Convert raw input (CLI strings or UI values) to the param's type. Empty values mean "unset". */
export function coerceParam(server: string, name: string, spec: ParamSpec | undefined, raw: unknown): ParamValue | undefined {
  if (!spec) throw new LoadoutError(`Server "${server}" has no param "${name}"`);
  if (raw === undefined || raw === null || raw === '') return undefined;
  switch (spec.type) {
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n)) throw new LoadoutError(`Param "${name}" must be a number`);
      return n;
    }
    case 'boolean':
      if (typeof raw === 'boolean') return raw;
      if (/^(true|yes|1)$/i.test(String(raw))) return true;
      if (/^(false|no|0)$/i.test(String(raw))) return false;
      throw new LoadoutError(`Param "${name}" must be true or false`);
    default:
      return String(raw).trim();
  }
}

/** Params each repository must set before the server can be attached (required, no default). */
export function requiredParams(def: ServerDef): string[] {
  return Object.entries(def.params ?? {})
    .filter(([, spec]) => spec.required && spec.default === undefined)
    .map(([name]) => name);
}

/**
 * Set a repository's param values for a shared server, after validating them.
 * `replace` takes the given values as the complete set; otherwise they are merged into the current ones
 * (an empty value removes a param). With `attach`, the server is attached first if needed.
 */
export function updateBindingParams(
  registry: Registry,
  repo: string,
  server: string,
  values: Record<string, unknown>,
  opts: { replace?: boolean; attach?: boolean } = {},
): Record<string, ParamValue> {
  const def = registry.servers.get(server);
  if (!def) {
    if (registry.repoServers.get(repo)?.has(server)) {
      throw new LoadoutError(`"${server}" is ${repo}'s own server: edit its definition (defaults) instead of binding params`);
    }
    throw new LoadoutError(`Unknown shared server "${server}"`);
  }
  const binding = registry.bindings.get(repo)?.find((b) => b.server === server);
  if (!binding && !opts.attach) throw new LoadoutError(`${server} is not attached to ${repo}`);
  const next: Record<string, ParamValue> = opts.replace ? {} : { ...(binding?.params ?? {}) };
  for (const [name, raw] of Object.entries(values)) {
    const v = coerceParam(server, name, def.params?.[name], raw);
    if (v === undefined) delete next[name];
    else next[name] = v;
  }
  try {
    resolveParams(def, { server, params: next }, repoContext(repo, `/path/to/${repo.split('/').pop()}`));
  } catch (e) {
    throw new LoadoutError((e as Error).message);
  }
  if (!binding) attachServers(registry.bindingsPath, repo, [server]);
  setBindingParams(registry.bindingsPath, repo, server, next);
  return next;
}
