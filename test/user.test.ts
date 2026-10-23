import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachServers, detachServers, USER_SCOPE } from '../src/bindings-edit.js';
import { updateBindingParams } from '../src/params.js';
import { loadRegistry } from '../src/registry.js';
import { importUser, syncUser, userStatus } from '../src/user.js';
import { State } from '../src/writer.js';
import { tmp, write } from './helpers.js';

const LINKUP = `name: linkup
transport:
  type: http
  url: https://mcp.linkup.so/mcp
  headers:
    Authorization: "Bearer {{ params.apiKey }}"
params:
  apiKey: { type: secret, default: env://LINKUP_API_KEY }
`;
const CONTEXT7 = 'name: context7\ntransport:\n  type: http\n  url: https://mcp.context7.com/mcp\n';
const GRAPH = `name: code-graph
transport:
  type: stdio
  package: { registry: pypi, name: code-graph-mcp, version: 1.2.4 }
  args: ["--project-root", "{{ repo.root }}"]
`;

let home: string;
const previousHome = process.env.LOADOUT_HOME;
beforeEach(() => {
  home = tmp('loadout-home-');
  process.env.LOADOUT_HOME = home;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.LOADOUT_HOME;
  else process.env.LOADOUT_HOME = previousHome;
});

function setup(bindings = 'user: [linkup, context7]\nrepositories: {}\n') {
  const base = tmp();
  const reg = join(base, 'registry');
  write(reg, 'servers/linkup.yaml', LINKUP);
  write(reg, 'servers/context7.yaml', CONTEXT7);
  write(reg, 'servers/code-graph.yaml', GRAPH);
  write(reg, 'bindings.yaml', bindings);
  const state = State.load(join(base, 'state'));
  return { reg, state, registry: () => loadRegistry(reg).registry };
}

const claudeJson = () => JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
const outcomes = (r: ReturnType<typeof syncUser>, i = 0) =>
  Object.fromEntries(r.files[i].entries.map((e) => [e.name, e.outcome]));

describe('user scope in bindings.yaml', () => {
  it('validates user-scope servers', () => {
    const { reg } = setup('user: [linkup, nope, code-graph]\nrepositories:\n  github.com/acme/app: [context7]\n');
    const msgs = loadRegistry(reg).problems.map((p) => p.message);
    expect(msgs).toContainEqual(expect.stringMatching(/user → nope: unknown server/));
    expect(msgs).toContainEqual(expect.stringMatching(/user → code-graph: uses \{\{ repo.root \}\}/));
    expect(loadRegistry(reg).registry.userBindings.map((b) => b.server)).toEqual(['linkup']);
  });

  it('warns when a repository also attaches a user-scope server', () => {
    const { reg } = setup('user: [context7]\nrepositories:\n  github.com/acme/app: [context7]\n');
    expect(loadRegistry(reg).problems).toEqual([
      expect.objectContaining({ level: 'warning', message: expect.stringMatching(/also in user scope/) }),
    ]);
  });

  it('adds `user:` above repositories, keeping comments, and edits its params', () => {
    const { reg, registry } = setup('# header\n\n# repos\nrepositories:\n  github.com/acme/app: [context7] # note\n');
    expect(attachServers(join(reg, 'bindings.yaml'), USER_SCOPE, ['linkup', 'context7'])).toEqual(['linkup', 'context7']);
    const text = readFileSync(join(reg, 'bindings.yaml'), 'utf8');
    expect(text).toMatch(
      /^# header\n[\s\S]*user: \[linkup, context7\]\nrepositories:\n {2}github.com\/acme\/app: \[context7\] # note\n$/,
    );
    updateBindingParams(registry(), USER_SCOPE, 'linkup', { apiKey: 'env://MY_LINKUP' });
    expect(registry().userBindings[0]).toEqual({ server: 'linkup', params: { apiKey: 'env://MY_LINKUP' } });
    expect(detachServers(join(reg, 'bindings.yaml'), USER_SCOPE, ['linkup'])).toEqual(['linkup']);
    expect(registry().userBindings.map((b) => b.server)).toEqual(['context7']);
  });
});

describe('syncUser', () => {
  it('merges into the user configs, keeping every other setting and entry', () => {
    const { state, registry } = setup();
    write(
      home,
      '.claude.json',
      JSON.stringify({ numStartups: 3, projects: { '/x': { mcpServers: {} } }, mcpServers: { mine: { command: 'x' } } }),
    );
    const r = syncUser(registry(), ['claude-code', 'cursor'], state);
    expect(outcomes(r, 0)).toEqual({ linkup: 'added', context7: 'added' });
    expect(r.files[0].unmanaged).toEqual(['mine']);
    expect(r.envVars).toEqual(['LINKUP_API_KEY']);
    const json = claudeJson();
    expect(json.numStartups).toBe(3);
    expect(json.projects).toEqual({ '/x': { mcpServers: {} } });
    expect(Object.keys(json.mcpServers)).toEqual(['mine', 'linkup', 'context7']);
    expect(json.mcpServers.linkup.headers.Authorization).toBe('Bearer ${LINKUP_API_KEY}');
    const cursor = JSON.parse(readFileSync(join(home, '.cursor/mcp.json'), 'utf8'));
    expect(cursor.mcpServers.linkup.headers.Authorization).toBe('Bearer ${env:LINKUP_API_KEY}');
    expect(outcomes(syncUser(registry(), ['claude-code'], state))).toEqual({ linkup: 'unchanged', context7: 'unchanged' });
    expect(userStatus(registry(), ['claude-code'], state)[0]).toMatchObject({
      entries: [
        { name: 'linkup', status: 'ok' },
        { name: 'context7', status: 'ok' },
      ],
      unmanaged: ['mine'],
    });
  });

  it('updates and removes only its own entries', () => {
    const { reg, state, registry } = setup();
    syncUser(registry(), ['claude-code'], state);
    write(reg, 'servers/context7.yaml', CONTEXT7.replace('/mcp', '/mcp/v2'));
    expect(userStatus(registry(), ['claude-code'], state)[0].entries[1]).toEqual({ name: 'context7', status: 'stale' });
    expect(outcomes(syncUser(registry(), ['claude-code'], state)).context7).toBe('updated');

    // Edited by hand, then dropped from user scope: left in place.
    const json = claudeJson();
    json.mcpServers.linkup.url = 'https://example.com/mine';
    writeFileSync(join(home, '.claude.json'), JSON.stringify(json));
    write(reg, 'bindings.yaml', 'user: []\nrepositories: {}\n');
    expect(userStatus(registry(), ['claude-code'], state)[0].entries).toEqual([{ name: 'context7', status: 'orphan' }]);
    expect(outcomes(syncUser(registry(), ['claude-code'], state))).toEqual({ context7: 'removed', linkup: 'kept' });
    expect(Object.keys(claudeJson().mcpServers)).toEqual(['linkup']);
    // No longer tracked: a later sync leaves it alone too.
    expect(syncUser(registry(), ['claude-code'], state).files[0]).toMatchObject({ entries: [], unmanaged: ['linkup'] });
  });

  it('refuses to replace a hand-written entry unless forced, keeping a backup', () => {
    const { state, registry } = setup();
    write(home, '.claude.json', JSON.stringify({ mcpServers: { context7: { type: 'http', url: 'https://old' } } }));
    const r = syncUser(registry(), ['claude-code'], state);
    expect(outcomes(r)).toEqual({ linkup: 'added', context7: 'conflict' });
    expect(claudeJson().mcpServers.context7.url).toBe('https://old');
    expect(userStatus(registry(), ['claude-code'], state)[0].entries[1].status).toBe('modified');
    const forced = syncUser(registry(), ['claude-code'], state, { force: true });
    expect(outcomes(forced).context7).toBe('replaced');
    expect(claudeJson().mcpServers.context7.url).toBe('https://mcp.context7.com/mcp');
    expect(readFileSync(forced.files[0].backup!, 'utf8')).toContain('https://old');
  });

  it('writes nothing on a dry run, and refuses a broken JSON file', () => {
    const { state, registry } = setup();
    syncUser(registry(), ['claude-code'], state, { dryRun: true });
    expect(existsSync(join(home, '.claude.json'))).toBe(false);
    write(home, '.claude.json', '{ not json');
    expect(() => syncUser(registry(), ['claude-code'], state)).toThrow(/not valid JSON/);
  });
});

describe('importUser', () => {
  it('turns hand-written user entries into shared servers without copying secrets', () => {
    const { reg, state, registry } = setup('repositories:\n  github.com/acme/app: [linkup]\n');
    write(
      home,
      '.claude.json',
      JSON.stringify({
        mcpServers: {
          context7: { type: 'http', url: 'https://mcp.context7.com/mcp' },
          gh: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ghp_REAL' } },
          linkup: { type: 'http', url: 'https://other.example/mcp' },
        },
      }),
    );
    write(home, '.cursor/mcp.json', JSON.stringify({ mcpServers: { gh: { url: 'https://api.githubcopilot.com/mcp/' } } }));
    const r = importUser(registry(), ['claude-code', 'cursor'], state);
    expect(r).toMatchObject({ created: ['gh'], reused: ['context7'], skipped: ['linkup'], added: ['context7', 'gh'] });
    expect(r.notes.join('\n')).toMatch(/export GH_AUTHORIZATION|export GH_TOKEN/);
    expect(readFileSync(join(reg, 'servers/gh.yaml'), 'utf8')).not.toContain('ghp_REAL');
    expect(registry().userBindings.map((b) => b.server)).toEqual(['context7', 'gh']);

    const s = syncUser(registry(), ['claude-code', 'cursor'], state, { force: true });
    expect(outcomes(s, 0)).toEqual({ context7: 'unchanged', gh: 'replaced' });
    expect(JSON.stringify(claudeJson())).not.toContain('ghp_REAL');
    expect(claudeJson().mcpServers.linkup.url).toBe('https://other.example/mcp');
    expect(importUser(registry(), ['claude-code', 'cursor'], state).sources).toEqual([join(home, '.claude.json')]);
  });
});
