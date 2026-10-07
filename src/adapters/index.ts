import type { Part, ResolvedServer, Value } from '../types.js';

export const ADAPTER_IDS = ['claude-code', 'cursor'] as const;
export type AdapterId = (typeof ADAPTER_IDS)[number];

export interface Adapter {
  id: AdapterId;
  /** Config file path, relative to the repository root. */
  path: string;
  render(servers: ResolvedServer[]): string;
}

function formatter(env: (name: string) => string) {
  return (value: Value) => value.map((p: Part) => (p.kind === 'text' ? p.value : env(p.name))).join('');
}

function renderMcpServers(
  servers: ResolvedServer[],
  fmt: (v: Value) => string,
  shape: (s: ResolvedServer, fmt: (v: Value) => string) => Record<string, unknown>,
): string {
  const mcpServers: Record<string, unknown> = {};
  for (const s of servers) mcpServers[s.name] = shape(s, fmt);
  return JSON.stringify({ mcpServers }, null, 2) + '\n';
}

function fromEntries(entries: Array<[string, Value]>, fmt: (v: Value) => string) {
  return Object.fromEntries(entries.map(([k, v]) => [k, fmt(v)]));
}

/** Claude Code project config: .mcp.json, `${VAR}` expansion. */
export const claudeCode: Adapter = {
  id: 'claude-code',
  path: '.mcp.json',
  render: (servers) =>
    renderMcpServers(servers, formatter((n) => `\${${n}}`), (s, fmt) => {
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
    }),
};

/** Cursor project config: .cursor/mcp.json, `${env:VAR}` interpolation. */
export const cursor: Adapter = {
  id: 'cursor',
  path: '.cursor/mcp.json',
  render: (servers) =>
    renderMcpServers(servers, formatter((n) => `\${env:${n}}`), (s, fmt) => {
      const t = s.transport;
      if (t.type === 'http') {
        return { url: fmt(t.url), ...(t.headers.length ? { headers: fromEntries(t.headers, fmt) } : {}) };
      }
      return {
        command: fmt(t.command),
        args: t.args.map(fmt),
        ...(t.env.length ? { env: fromEntries(t.env, fmt) } : {}),
      };
    }),
};

export const ADAPTERS: Record<AdapterId, Adapter> = { 'claude-code': claudeCode, cursor };
