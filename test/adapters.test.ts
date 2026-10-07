import { describe, expect, it } from 'vitest';
import { claudeCode, cursor } from '../src/adapters/index.js';
import type { ResolvedServer } from '../src/types.js';

const servers: ResolvedServer[] = [
  {
    name: 'linkup',
    transport: {
      type: 'http',
      url: [{ kind: 'text', value: 'https://mcp.linkup.so/mcp' }],
      headers: [['Authorization', [{ kind: 'text', value: 'Bearer ' }, { kind: 'env', name: 'LINKUP_API_KEY' }]]],
    },
  },
  {
    name: 'code-graph',
    transport: {
      type: 'stdio',
      command: [{ kind: 'text', value: 'uvx' }],
      args: [[{ kind: 'text', value: 'code-graph-mcp==1.2.4' }]],
      env: [['TOKEN', [{ kind: 'env', name: 'CG_TOKEN' }]]],
    },
  },
];

describe('adapters', () => {
  it('claude-code renders .mcp.json with ${VAR}', () => {
    expect(claudeCode.path).toBe('.mcp.json');
    expect(JSON.parse(claudeCode.render(servers))).toEqual({
      mcpServers: {
        linkup: { type: 'http', url: 'https://mcp.linkup.so/mcp', headers: { Authorization: 'Bearer ${LINKUP_API_KEY}' } },
        'code-graph': { type: 'stdio', command: 'uvx', args: ['code-graph-mcp==1.2.4'], env: { TOKEN: '${CG_TOKEN}' } },
      },
    });
  });

  it('cursor renders .cursor/mcp.json with ${env:VAR}', () => {
    expect(cursor.path).toBe('.cursor/mcp.json');
    expect(JSON.parse(cursor.render(servers))).toEqual({
      mcpServers: {
        linkup: { url: 'https://mcp.linkup.so/mcp', headers: { Authorization: 'Bearer ${env:LINKUP_API_KEY}' } },
        'code-graph': { command: 'uvx', args: ['code-graph-mcp==1.2.4'], env: { TOKEN: '${env:CG_TOKEN}' } },
      },
    });
  });
});
