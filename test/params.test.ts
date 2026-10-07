import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commitAdd, previewAdd, readServerSource, writeServerSource } from '../src/add.js';
import { coerceParam, updateBindingParams } from '../src/params.js';
import { loadRegistry } from '../src/registry.js';
import { resolveRepo } from '../src/sync.js';
import { ctx, tmp, write } from './helpers.js';

const PG = `name: postgres
transport:
  type: stdio
  package: { registry: npm, name: "@acme/pg-mcp", version: 1.0.0 }
  args: ["--database", "{{ params.database }}", "--read-only={{ params.readOnly }}"]
  env: { PGPASSWORD: "{{ params.password }}" }
params:
  database: { type: string, required: true }
  readOnly: { type: boolean, default: true }
  password: { type: secret, default: env://PGPASSWORD }
`;

function setup(bindings = 'repositories:\n  # app\n  github.com/acme/app: [linkup] # inline\n') {
  const root = tmp();
  write(root, 'servers/postgres.yaml', PG);
  write(root, 'servers/linkup.yaml', 'name: linkup\ntransport: { type: http, url: https://l }\n');
  write(root, 'bindings.yaml', bindings);
  return { root, registry: () => loadRegistry(root).registry, text: () => readFileSync(join(root, 'bindings.yaml'), 'utf8') };
}

describe('coerceParam', () => {
  it('converts by type and treats empty as unset', () => {
    const spec = (type: 'string' | 'number' | 'boolean' | 'secret') => ({ type });
    expect(coerceParam('s', 'n', spec('number'), '42')).toBe(42);
    expect(coerceParam('s', 'b', spec('boolean'), 'false')).toBe(false);
    expect(coerceParam('s', 'x', spec('string'), '')).toBeUndefined();
    expect(() => coerceParam('s', 'n', spec('number'), 'abc')).toThrow(/number/);
    expect(() => coerceParam('s', 'nope', undefined, 'x')).toThrow(/no param "nope"/);
  });
});

describe('updateBindingParams', () => {
  it('attaches with params, switches to the map form, and back to the list form', () => {
    const { registry, text } = setup();
    expect(() => updateBindingParams(registry(), 'github.com/acme/app', 'postgres', {})).toThrow(/not attached/);
    expect(() => updateBindingParams(registry(), 'github.com/acme/app', 'postgres', {}, { attach: true })).toThrow(
      /requires param "database"/,
    );
    expect(text()).not.toContain('postgres'); // nothing written on validation errors

    updateBindingParams(
      registry(),
      'github.com/acme/app',
      'postgres',
      { database: 'promo', readOnly: 'false', password: '' },
      { attach: true, replace: true },
    );
    expect(text()).toBe(
      'repositories:\n  # app\n  github.com/acme/app: # inline\n    linkup:\n    postgres:\n      params:\n        database: promo\n        readOnly: false\n',
    );
    const pg = resolveRepo(registry(), ctx('github.com/acme/app', '/w/app'))[1].transport;
    expect(
      pg.type === 'stdio' && pg.args.map((a) => a.map((p) => (p.kind === 'text' ? p.value : `$${p.name}`)).join('')),
    ).toEqual(['-y', '@acme/pg-mcp@1.0.0', '--database', 'promo', '--read-only=false']);

    // merge mode: change one value, keep the others
    updateBindingParams(registry(), 'github.com/acme/app', 'postgres', { password: 'env://PROMO_PW' });
    expect(registry().bindings.get('github.com/acme/app')![1].params).toEqual({
      database: 'promo',
      readOnly: false,
      password: 'env://PROMO_PW',
    });

    // secrets must stay references, and the value is not echoed
    expect(() => updateBindingParams(registry(), 'github.com/acme/app', 'postgres', { password: 'hunter2' })).toThrow(
      /not a secret reference/,
    );

    // linkup has no params; removing all postgres values is invalid (database required), so detach-style reset uses linkup
    updateBindingParams(registry(), 'github.com/acme/app', 'linkup', {}, { replace: true });
    expect(text()).toContain('postgres:\n      params:');
  });

  it('keeps the end-of-line comment when switching forms both ways', () => {
    const { registry, text } = setup(
      'repositories:\n  github.com/acme/app:\n    linkup: { params: {} }\n    postgres: { params: { database: x } }\n',
    );
    writeFileSync(join(registry().root, 'bindings.yaml'), 'repositories:\n  github.com/acme/app: [linkup] # note\n');
    updateBindingParams(registry(), 'github.com/acme/app', 'postgres', { database: 'x' }, { attach: true });
    expect(text()).toContain('github.com/acme/app: # note\n');
    updateBindingParams(registry(), 'github.com/acme/app', 'linkup', {}, { replace: true });
    expect(text()).toContain('postgres:\n      params:\n        database: x\n');
  });

  it('returns to the compact list form when no server has params', () => {
    const { registry, text } = setup('repositories:\n  github.com/acme/app:\n    linkup:\n      params: {}\n');
    updateBindingParams(registry(), 'github.com/acme/app', 'linkup', {}, { replace: true });
    expect(text()).toBe('repositories:\n  github.com/acme/app: [linkup]\n');
  });

  it('refuses repository-only servers', () => {
    const { root, registry } = setup();
    write(root, 'repos/github.com/acme/app/db.yaml', 'name: db\ntransport: { type: http, url: https://d }\n');
    expect(() => updateBindingParams(registry(), 'github.com/acme/app', 'db', {})).toThrow(/own server/);
  });
});

describe('placeholders in added servers', () => {
  it('declares {{ params.x }} as required params; secret positions become secret params', () => {
    const { registry } = setup();
    const p = previewAdd(registry(), [
      {
        name: 'mongo',
        cfg: {
          command: 'npx',
          args: ['-y', 'mongo-mcp@2.0.0', '--db', '{{ params.db }}'],
          env: { MONGO_PASSWORD: '{{ params.pw }}' },
        },
      },
    ]);
    expect(p.servers[0].def.params).toEqual({ pw: { type: 'secret', required: true }, db: { type: 'string', required: true } });
    expect(p.servers[0].problems).toEqual([]);
    expect(p.notes.join()).toMatch(/db — set per repository/);
    expect(p.notes.join()).not.toMatch(/NOT copied/);
  });

  it('rejects placeholders on repository-only servers', () => {
    const { registry } = setup();
    const p = previewAdd(registry(), [{ name: 'x', cfg: { url: 'https://x/{{ params.tenant }}' } }], {
      repo: 'github.com/acme/app',
    });
    expect(p.servers[0].problems.map((x) => x.message).join()).toMatch(/no per-repository values/);
  });
});

describe('writeServerSource', () => {
  it('saves valid edits and rolls back edits that would break a repository', () => {
    const { root, registry } = setup('repositories:\n  github.com/acme/app: [linkup]\n');
    const { yaml } = readServerSource(registry(), 'linkup');
    writeServerSource(
      registry(),
      'linkup',
      yaml.replace('https://l', '"https://l/{{ params.region }}"') + 'params:\n  region: { type: string, default: eu }\n',
    );
    expect(readFileSync(join(root, 'servers/linkup.yaml'), 'utf8')).toContain('region');

    const broken = readFileSync(join(root, 'servers/linkup.yaml'), 'utf8').replace('default: eu', 'required: true');
    expect(() => writeServerSource(registry(), 'linkup', broken)).toThrow(/requires param "region"/);
    expect(readFileSync(join(root, 'servers/linkup.yaml'), 'utf8')).toContain('default: eu');

    expect(() => writeServerSource(registry(), 'linkup', 'name: other\ntransport: { type: http, url: https://x }\n')).toThrow(
      /must match/,
    );
    expect(() => writeServerSource(registry(), 'linkup', ': : :')).toThrow(/Invalid YAML/);
    writeFileSync(join(root, 'unused'), '');
  });

  it('commitAdd still works for servers with params', () => {
    const { registry } = setup();
    const p = previewAdd(registry(), [{ name: 'svc', cfg: { url: 'https://svc/{{ params.tenant }}' } }]);
    expect(commitAdd(registry(), p)).toEqual(['svc']);
  });
});
