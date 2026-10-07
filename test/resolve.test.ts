import { describe, expect, it } from 'vitest';
import { resolveServer, secretEnvNames } from '../src/resolve.js';
import type { ServerDef } from '../src/types.js';
import { ctx } from './helpers.js';

const linkup: ServerDef = {
  name: 'linkup',
  transport: { type: 'http', url: 'https://mcp.linkup.so/mcp', headers: { Authorization: 'Bearer {{ params.apiKey }}' } },
  params: { apiKey: { type: 'secret', default: 'env://LINKUP_API_KEY' } },
};

const postgres: ServerDef = {
  name: 'postgres',
  transport: {
    type: 'stdio',
    package: { registry: 'npm', name: '@acme/pg', version: '1.2.3' },
    args: ['--db', '{{ params.database }}', '--root={{ repo.root }}'],
    env: { PGPASSWORD: '{{ params.password }}', READ_ONLY: '{{ params.readOnly }}', LABEL: '{{ params.label }}' },
  },
  params: {
    database: { type: 'string', required: true },
    password: { type: 'secret', required: true },
    readOnly: { type: 'boolean', default: true },
    label: { type: 'string', default: '{{ repo.name }}' },
  },
};

describe('resolveServer', () => {
  it('turns secret params into env parts', () => {
    const r = resolveServer(linkup, { server: 'linkup', params: {} }, ctx());
    expect(r.transport).toEqual({
      type: 'http',
      url: [{ kind: 'text', value: 'https://mcp.linkup.so/mcp' }],
      headers: [['Authorization', [{ kind: 'text', value: 'Bearer ' }, { kind: 'env', name: 'LINKUP_API_KEY' }]]],
    });
    expect(secretEnvNames(r)).toEqual(['LINKUP_API_KEY']);
  });

  it('expands packages, repo variables, defaults and binding params', () => {
    const r = resolveServer(postgres, { server: 'postgres', params: { database: 'promo', password: 'env://PG_PW' } }, ctx());
    expect(r.transport.type).toBe('stdio');
    if (r.transport.type !== 'stdio') return;
    const text = (v: { kind: string; value?: string; name?: string }[]) => v.map((p) => p.value ?? `<${p.name}>`).join('');
    expect(text(r.transport.command)).toBe('npx');
    expect(r.transport.args.map(text)).toEqual(['-y', '@acme/pg@1.2.3', '--db', 'promo', '--root=/work/app']);
    expect(Object.fromEntries(r.transport.env.map(([k, v]) => [k, text(v)]))).toEqual({
      PGPASSWORD: '<PG_PW>',
      READ_ONLY: 'true',
      LABEL: 'app',
    });
  });

  it('rejects literal secrets without echoing them', () => {
    expect(() => resolveServer(postgres, { server: 'postgres', params: { database: 'x', password: 'hunter2-very-secret' } }, ctx())).toThrow(
      /not a secret reference/,
    );
    try {
      resolveServer(postgres, { server: 'postgres', params: { database: 'x', password: 'hunter2-very-secret' } }, ctx());
    } catch (e) {
      expect((e as Error).message).not.toContain('hunter2');
    }
  });

  it('rejects unsupported secret providers, unknown and missing params, wrong types', () => {
    const bind = (params: Record<string, string | number | boolean>) => () => resolveServer(postgres, { server: 'postgres', params }, ctx());
    expect(bind({ database: 'x', password: 'vault://kv/x' })).toThrow(/not supported yet/);
    expect(bind({ password: 'env://X' })).toThrow(/requires param "database"/);
    expect(bind({ database: 'x', password: 'env://X', nope: 1 })).toThrow(/no param "nope"/);
    expect(bind({ database: 'x', password: 'env://X', readOnly: 'yes' })).toThrow(/must be a boolean/);
  });

  it('omits entries that reference an unset optional param', () => {
    const def: ServerDef = {
      name: 'c7',
      transport: { type: 'http', url: 'https://x', headers: { KEY: '{{ params.apiKey }}', Other: 'v' } },
      params: { apiKey: { type: 'secret' } },
    };
    const r = resolveServer(def, { server: 'c7', params: {} }, ctx());
    expect(r.transport.type === 'http' && r.transport.headers.map(([k]) => k)).toEqual(['Other']);
  });
});
