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
    write(root, 'servers/linkup.yaml', 'name: linkup\ntransport: { type: http, url: https://mcp.linkup.so/mcp }\n');
    write(root, 'bindings.yaml', 'repositories: {}\n');
    ui = await startUi({ registryRoot: root, config: { workspaces: [], targets: ['claude-code'] }, port: 0 });
    const u = new URL(ui.url);
    base = u.origin;
    token = u.searchParams.get('token')!;
  });
  afterAll(() => ui.close());

  const call = (path: string, init: RequestInit = {}, withToken = true) =>
    fetch(base + path, { ...init, headers: { 'Content-Type': 'application/json', ...(withToken ? { 'X-Loadout-Token': token } : {}) } });

  it('requires the token for the page and the API', async () => {
    expect((await fetch(base + '/')).status).toBe(403);
    expect((await fetch(`${base}/?token=${token}`)).status).toBe(200);
    expect((await call('/api/state', {}, false)).status).toBe(403);
    expect((await call('/api/state')).status).toBe(200);
  });

  it('adds a server, attaches it, and reports errors as 400', async () => {
    const add = await call('/api/servers', {
      method: 'POST',
      body: JSON.stringify({ mode: 'json', text: '{"mcpServers":{"ctx":{"url":"https://c/mcp?token=abc"}}}', attach: ['https://github.com/acme/app.git'] }),
    });
    expect(await add.json()).toEqual({ written: ['ctx'], attached: ['https://github.com/acme/app.git'] });
    expect(readFileSync(join(root, 'servers/ctx.yaml'), 'utf8')).not.toContain('abc');
    expect(readFileSync(join(root, 'bindings.yaml'), 'utf8')).toContain('github.com/acme/app: [ctx]');

    const state = await (await call('/api/state')).json();
    expect(state.repos).toEqual([{ id: 'github.com/acme/app', servers: ['ctx'], clones: [] }]);

    const dup = await call('/api/servers', { method: 'POST', body: JSON.stringify({ mode: 'form', form: { name: 'ctx', kind: 'remote', url: 'https://x' } }) });
    expect(dup.status).toBe(400);
    expect((await dup.json()).error).toMatch(/already exists/);

    const detach = await call('/api/bindings', { method: 'POST', body: JSON.stringify({ repo: 'github.com/acme/app', server: 'ctx', attached: false }) });
    expect(detach.status).toBe(200);
    expect((await call('/api/servers/ctx', { method: 'DELETE' })).status).toBe(200);
  });
});
