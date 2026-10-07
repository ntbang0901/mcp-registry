import { LoadoutError } from './errors.js';
import { renderRepoOnly, renderTemplate, type ResolvedParam } from './template.js';
import type { Binding, RepoContext, ResolvedServer, ServerDef, Value } from './types.js';

const SECRET_REF = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parse a secret reference. v0.1 supports only env://NAME. */
export function parseSecretRef(ref: string): { env: string } {
  const m = SECRET_REF.exec(ref);
  if (!m) {
    // Never echo the value: it may be a pasted secret.
    throw new LoadoutError('value is not a secret reference; use env://NAME (literal secrets are not allowed)');
  }
  const [, scheme, rest] = m;
  if (scheme !== 'env') throw new LoadoutError(`Secret provider "${scheme}://" is not supported yet (v0.1 supports env://)`);
  if (!ENV_NAME.test(rest)) throw new LoadoutError(`Invalid environment variable name in "${ref}"`);
  return { env: rest };
}

export function resolveParams(server: ServerDef, binding: Binding, repo: RepoContext): Map<string, ResolvedParam> {
  const specs = server.params ?? {};
  for (const key of Object.keys(binding.params)) {
    if (!(key in specs)) {
      const known = Object.keys(specs);
      throw new LoadoutError(
        `Server "${server.name}" has no param "${key}"${known.length ? ` (params: ${known.join(', ')})` : ''}`,
      );
    }
  }
  const out = new Map<string, ResolvedParam>();
  for (const [name, spec] of Object.entries(specs)) {
    let raw = binding.params[name] ?? spec.default;
    if (raw === undefined) {
      if (spec.required) throw new LoadoutError(`Server "${server.name}" requires param "${name}"`);
      out.set(name, { kind: 'unset' });
      continue;
    }
    if (typeof raw === 'string' && binding.params[name] === undefined) raw = renderRepoOnly(raw, repo);
    const where = `Param "${name}" of server "${server.name}"`;
    if (spec.type === 'secret') {
      if (typeof raw !== 'string') throw new LoadoutError(`${where} must be a secret reference like env://NAME`);
      try {
        out.set(name, { kind: 'secret', ...parseSecretRef(raw) });
      } catch (e) {
        throw new LoadoutError(`${where}: ${(e as Error).message}`);
      }
      continue;
    }
    if (typeof raw !== spec.type) throw new LoadoutError(`${where} must be a ${spec.type}, got ${JSON.stringify(raw)}`);
    out.set(name, { kind: 'value', value: raw });
  }
  return out;
}

export function resolveServer(server: ServerDef, binding: Binding, repo: RepoContext): ResolvedServer {
  const params = resolveParams(server, binding, repo);
  const render = (tpl: string) => renderTemplate(tpl, repo, params);
  const renderMap = (map: Record<string, string> | undefined) => {
    const out: Array<[string, Value]> = [];
    for (const [k, tpl] of Object.entries(map ?? {})) {
      const v = render(tpl);
      if (v) out.push([k, v]);
    }
    return out;
  };
  const t = server.transport;
  if (t.type === 'http') {
    const url = render(t.url);
    if (!url) throw new LoadoutError(`Server "${server.name}": url references an unset param`);
    return { name: server.name, transport: { type: 'http', url, headers: renderMap(t.headers) } };
  }
  let command: string;
  let prefix: string[] = [];
  if (t.package) {
    const { registry, name, version } = t.package;
    command = registry === 'npm' ? 'npx' : 'uvx';
    prefix = registry === 'npm' ? ['-y', `${name}@${version}`] : [`${name}==${version}`];
  } else {
    command = t.command!;
  }
  const cmd = render(command);
  if (!cmd) throw new LoadoutError(`Server "${server.name}": command references an unset param`);
  const args: Value[] = prefix.map((value) => [{ kind: 'text', value }]);
  for (const tpl of t.args ?? []) {
    const v = render(tpl);
    if (v) args.push(v);
  }
  return { name: server.name, transport: { type: 'stdio', command: cmd, args, env: renderMap(t.env) } };
}

/** Environment variables a resolved server reads secrets from. */
export function secretEnvNames(server: ResolvedServer): string[] {
  const t = server.transport;
  const values = t.type === 'http' ? [t.url, ...t.headers.map(([, v]) => v)] : [t.command, ...t.args, ...t.env.map(([, v]) => v)];
  return [...new Set(values.flat().flatMap((p) => (p.kind === 'env' ? [p.name] : [])))];
}
