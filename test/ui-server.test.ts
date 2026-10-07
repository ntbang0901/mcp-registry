import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startUi } from '../src/ui-server.js';
import { tmp, write } from './helpers.js';

describe('ui server', () => {
  const root = tmp();
  let ui: { url: string; close: () => void };
  let base: string;
  let token: string;

  beforeAll(async () => {
    process.env.LOADOUT_STATE_DIR = join(root, 'state');
    process.env.LOADOUT_CONFIG = join(root, 'config.yaml');
    write(root, 'servers/linkup.yaml', 'name: linkup\ntransport: { type: http, url: https://mcp.linkup.so/mcp }\n');
    write(root, 'bindings.yaml', 'repositories: {}\n');
    ui = await startUi({ registryRoot: root, config: { workspaces: [], targets: ['claude-code'] }, port: 0 });
    const u = new URL(ui.url);
    base = u.origin;
    token = u.searchParams.get('token')!;
  });
  afterAll(() => ui.close());

  const call = (path: string, init: RequestInit = {}, withToken = true) =>
    fetch(base + path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(withToken ? { 'X-Loadout-Token': token } : {}) },
    });

  it('requires the token for the page and the API', async () => {
    expect((await fetch(base + '/')).status).toBe(403);
    expect((await fetch(`${base}/?token=${token}`)).status).toBe(200);
    expect((await call('/api/state', {}, false)).status).toBe(403);
    expect((await call('/api/state')).status).toBe(200);
  });

  it('adds a server, attaches it, and reports errors as 400', async () => {
    const add = await call('/api/servers', {
      method: 'POST',
      body: JSON.stringify({
        mode: 'json',
        text: '{"mcpServers":{"ctx":{"url":"https://c/mcp?token=abc"}}}',
        attach: ['https://github.com/acme/app.git'],
      }),
    });
    expect(await add.json()).toEqual({ written: ['ctx'], attached: ['github.com/acme/app'], needsParams: [] });
    expect(readFileSync(join(root, 'servers/ctx.yaml'), 'utf8')).not.toContain('abc');
    expect(readFileSync(join(root, 'bindings.yaml'), 'utf8')).toContain('github.com/acme/app: [ctx]');

    const state = await (await call('/api/state')).json();
    expect(state.repos).toEqual([
      {
        id: 'github.com/acme/app',
        servers: ['ctx'],
        own: [],
        params: { ctx: {} },
        clones: [],
        env: [{ name: 'CTX_TOKEN', set: false }],
      },
    ]);

    const dup = await call('/api/servers', {
      method: 'POST',
      body: JSON.stringify({ mode: 'form', form: { name: 'ctx', kind: 'remote', url: 'https://x' } }),
    });
    expect(dup.status).toBe(400);
    expect((await dup.json()).error).toMatch(/already exists/);

    const detach = await call('/api/bindings', {
      method: 'POST',
      body: JSON.stringify({ repo: 'github.com/acme/app', server: 'ctx', attached: false }),
    });
    expect(detach.status).toBe(200);
    expect((await call('/api/servers/ctx', { method: 'DELETE' })).status).toBe(200);
  });

  it('adds and removes scanned folders', async () => {
    const post = (body: unknown) => call('/api/workspaces', { method: 'POST', body: JSON.stringify(body) });
    const missing = await post({ add: join(root, 'nope') });
    expect((await missing.json()).error).toMatch(/is not a folder/);
    const added = await (await post({ add: root })).json();
    expect(added.workspaces).toEqual([root]);
    expect((await (await post({ add: join(root, 'servers') })).json()).note).toMatch(/already scanned as part of/);
    expect((await (await post({ remove: root })).json()).workspaces).toEqual([]);
  });

  it('sets per-repository params and edits server definitions', async () => {
    write(
      root,
      'servers/pg.yaml',
      'name: pg\ntransport: { type: http, url: "https://pg/{{ params.db }}" }\nparams:\n  db: { type: string, required: true }\n',
    );
    const post = (path: string, body: unknown) => call(path, { method: 'POST', body: JSON.stringify(body) });
    const direct = await post('/api/bindings', { repo: 'github.com/acme/app', server: 'pg', attached: true });
    expect((await direct.json()).error).toMatch(/needs values for db/);
    const missing = await post('/api/params', { repo: 'github.com/acme/app', server: 'pg', params: {}, attach: true });
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toMatch(/requires param "db"/);
    const ok = await post('/api/params', { repo: 'github.com/acme/app', server: 'pg', params: { db: 'promo' }, attach: true });
    expect(await ok.json()).toEqual({ params: { db: 'promo' } });
    const state = await (await call('/api/state')).json();
    expect(state.repos[0].params.pg).toEqual({ db: 'promo' });
    expect(state.servers.find((s: { name: string }) => s.name === 'pg').params).toEqual([
      { name: 'db', type: 'string', required: true },
    ]);

    const src = await (await call('/api/servers/pg/source')).json();
    expect(src.path).toBe('servers/pg.yaml');
    const broken = await call('/api/servers/pg/source', {
      method: 'PUT',
      body: JSON.stringify({ yaml: src.yaml.replace('params:\n  db: { type: string, required: true }\n', '') }),
    });
    expect(broken.status).toBe(400);
    expect((await broken.json()).error).toMatch(/undeclared param "db"/);
    await post('/api/bindings', { repo: 'github.com/acme/app', server: 'pg', attached: false });
  });

  it('adds, shares and deletes repository-only servers', async () => {
    const body = {
      mode: 'form',
      repo: 'git@github.com:acme/svc.git',
      form: { name: 'db', kind: 'command', command: 'node tools/db.js' },
    };
    expect(await (await call('/api/servers', { method: 'POST', body: JSON.stringify(body) })).json()).toEqual({
      written: ['db'],
      attached: ['github.com/acme/svc'],
      needsParams: [],
    });
    let state = await (await call('/api/state')).json();
    expect(state.repoOnly.map((s: { name: string; repo: string }) => `${s.repo}/${s.name}`)).toEqual(['github.com/acme/svc/db']);
    expect(state.repos.find((r: { id: string }) => r.id === 'github.com/acme/svc').own).toEqual(['db']);

    expect(
      (await call('/api/share', { method: 'POST', body: JSON.stringify({ repo: 'github.com/acme/svc', name: 'db' }) })).status,
    ).toBe(200);
    state = await (await call('/api/state')).json();
    expect(state.repoOnly).toEqual([]);
    expect(state.servers.find((s: { name: string }) => s.name === 'db').usedBy).toEqual(['github.com/acme/svc']);

    expect(await (await call('/api/unshare', { method: 'POST', body: JSON.stringify({ name: 'db' }) })).json()).toEqual({
      repo: 'github.com/acme/svc',
    });
    expect((await call('/api/servers/db?repo=github.com/acme/svc', { method: 'DELETE' })).status).toBe(200);
    state = await (await call('/api/state')).json();
    expect(state.repoOnly).toEqual([]);
  });
});
