import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importRepo } from '../src/importer.js';
import { loadRegistry } from '../src/registry.js';
import { detectRepo } from '../src/repo.js';
import { repoStatus, syncRepo } from '../src/sync.js';
import { State } from '../src/writer.js';
import { gitRepo, tmp, write } from './helpers.js';

function setup() {
  const base = tmp();
  const reg = join(base, 'registry');
  write(
    reg,
    'servers/linkup.yaml',
    'name: linkup\ntransport:\n  type: http\n  url: https://mcp.linkup.so/mcp\n  headers: { Authorization: "Bearer {{ params.apiKey }}" }\nparams:\n  apiKey: { type: secret, default: env://LINKUP_API_KEY }\n',
  );
  write(reg, 'bindings.yaml', 'repositories:\n  github.com/acme/app: [linkup]\n');
  const app = detectRepo(gitRepo(join(base, 'code', 'app'), 'git@github.com:acme/app.git'));
  const state = State.load(join(base, 'state'));
  return { base, reg, app, state, registry: () => loadRegistry(reg).registry };
}

describe('syncRepo', () => {
  it('creates, keeps up to date, git-excludes, and refuses to overwrite hand-written files', () => {
    const { app, state, registry } = setup();
    const r1 = syncRepo(registry(), app, ['claude-code', 'cursor'], state, {});
    expect(r1.files.map((f) => f.outcome)).toEqual(['created', 'created']);
    expect(r1.envVars).toEqual(['LINKUP_API_KEY']);
    expect(readFileSync(join(app.root, '.mcp.json'), 'utf8')).toContain('Bearer ${LINKUP_API_KEY}');
    expect(readFileSync(join(app.root, '.git/info/exclude'), 'utf8')).toContain('/.cursor/mcp.json');

    expect(syncRepo(registry(), app, ['claude-code'], state, {}).files[0].outcome).toBe('unchanged');

    writeFileSync(join(app.root, '.mcp.json'), '{"mcpServers":{"mine":{"command":"x"}}}');
    expect(repoStatus(registry(), app, ['claude-code'], state).files[0].status).toBe('modified');
    expect(syncRepo(registry(), app, ['claude-code'], state, {}).files[0].outcome).toBe('conflict');
    expect(syncRepo(registry(), app, ['claude-code'], state, { force: true }).files[0].outcome).toBe('replaced');
    expect(existsSync(join(app.root, '.mcp.json.bak'))).toBe(true);
    expect(readFileSync(join(app.root, '.git/info/exclude'), 'utf8')).toContain('/.mcp.json.bak');
  });

  it('updates owned files and removes them when no servers remain', () => {
    const { reg, app, state, registry } = setup();
    syncRepo(registry(), app, ['cursor'], state, {});
    write(reg, 'bindings.yaml', 'repositories:\n  github.com/acme/app: []\n');
    expect(repoStatus(registry(), app, ['cursor'], state).files[0].status).toBe('orphan');
    expect(syncRepo(registry(), app, ['cursor'], state, {}).files[0].outcome).toBe('removed');
    expect(existsSync(join(app.root, '.cursor'))).toBe(false);
  });

  it('errors for repositories not in bindings.yaml', () => {
    const { base, state, registry } = setup();
    const other = detectRepo(gitRepo(join(base, 'code', 'other'), 'https://github.com/acme/other'));
    expect(() => syncRepo(registry(), other, ['cursor'], state, {})).toThrow(/not in .*bindings.yaml/);
  });
});

describe('importRepo', () => {
  it('imports client configs into the registry without secrets and attaches them', () => {
    const { reg, app, registry } = setup();
    write(app.root, '.mcp.json', JSON.stringify({ mcpServers: { search: { url: 'https://s.example/mcp?token=tok-SECRET' } } }));
    const r = importRepo(registry(), app);
    expect(r.created).toEqual(['search']);
    expect(r.attached).toEqual(['search']);
    const def = readFileSync(join(reg, 'servers/search.yaml'), 'utf8');
    expect(def).not.toContain('tok-SECRET');
    expect(def).toContain('{{ params.SEARCH_TOKEN }}');
    const loaded = loadRegistry(reg);
    expect(loaded.problems.filter((p) => p.level === 'error')).toEqual([]);
    expect(loaded.registry.bindings.get('github.com/acme/app')!.map((b) => b.server)).toEqual(['linkup', 'search']);
  });
});
