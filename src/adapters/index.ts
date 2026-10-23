import type { Part, ResolvedServer, Value } from '../types.js';

export const ADAPTER_IDS = ['claude-code', 'cursor'] as const;
export type AdapterId = (typeof ADAPTER_IDS)[number];

export interface Adapter {
  id: AdapterId;
  /** Config file path, relative to the repository root. */
  path: string;
  /** User-scope config file (servers available in every project), relative to the home directory. */
  userPath: string;
  render(servers: ResolvedServer[]): string;
  /** The `mcpServers` entries alone, for merging into a user-scope file that also holds other settings. */
  entries(servers: ResolvedServer[]): Record<string, Record<string, unknown>>;
}

function formatter(env: (name: string) => string) {
  return (value: Value) => value.map((p: Part) => (p.kind === 'text' ? p.value : env(p.name))).join('');
}

type Shape = (s: ResolvedServer, fmt: (v: Value) => string) => Record<string, unknown>;

function makeAdapter(id: AdapterId, path: string, userPath: string, env: (name: string) => string, shape: Shape): Adapter {
  const fmt = formatter(env);
  const entries = (servers: ResolvedServer[]) => Object.fromEntries(servers.map((s) => [s.name, shape(s, fmt)]));
  return {
    id,
    path,
    userPath,
    entries,
    render: (servers) => JSON.stringify({ mcpServers: entries(servers) }, null, 2) + '\n',
  };
}

function fromEntries(entries: Array<[string, Value]>, fmt: (v: Value) => string) {
  return Object.fromEntries(entries.map(([k, v]) => [k, fmt(v)]));
}

/** Claude Code: project .mcp.json, user scope in ~/.claude.json; `${VAR}` expansion. */
export const claudeCode = makeAdapter(
  'claude-code',
  '.mcp.json',
  '.claude.json',
  (n) => `\${${n}}`,
  (s, fmt) => {
    const t = s.transport;
    if (t.type === 'http') {
      return { type: 'http', url: fmt(t.url), ...(t.headers.length ? { headers: fromEntries(t.headers, fmt) } : {}) };
    }
    return {
      type: 'stdio',
      command: fmt(t.command),
      args: t.args.map(fmt),
      ...(t.env.length ? { env: fromEntries(t.env, fmt) } : {}),
    };
  },
);

/** Cursor: project .cursor/mcp.json, user scope in ~/.cursor/mcp.json; `${env:VAR}` interpolation. */
export const cursor = makeAdapter(
  'cursor',
  '.cursor/mcp.json',
  '.cursor/mcp.json',
  (n) => `\${env:${n}}`,
  (s, fmt) => {
    const t = s.transport;
    if (t.type === 'http') {
      return { url: fmt(t.url), ...(t.headers.length ? { headers: fromEntries(t.headers, fmt) } : {}) };
    }
    return {
      command: fmt(t.command),
      args: t.args.map(fmt),
      ...(t.env.length ? { env: fromEntries(t.env, fmt) } : {}),
    };
  },
);

export const ADAPTERS: Record<AdapterId, Adapter> = { 'claude-code': claudeCode, cursor };
