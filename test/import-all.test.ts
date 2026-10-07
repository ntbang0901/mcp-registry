import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findImportCandidates, importRepo, ImportSession } from '../src/importer.js';
import { loadRegistry } from '../src/registry.js';
import { detectRepo } from '../src/repo.js';
import { resolveRepo, syncRepo } from '../src/sync.js';
import { State } from '../src/writer.js';
import { gitRepo, tmp, write } from './helpers.js';

const pg = (db: string) => ({ command: 'npx', args: ['-y', '@acme/pg-mcp@1.0.0', '--db', db] });

function setup() {
  const base = tmp();
  const reg = join(base, 'registry');
  // A seeded shared server that no repository uses yet.
  write(
    reg,
    'servers/linkup.yaml',
    'name: linkup\ndescription: Web search\ntransport: { type: http, url: https://mcp.linkup.so/mcp }\n',
  );
  write(reg, 'bindings.yaml', 'repositories: {}\n');
  const code = join(base, 'code');
  const repo = (name: string, servers: Record<string, unknown>) => {
    const r = detectRepo(gitRepo(join(code, name), `git@github.com:acme/${name}.git`));
    write(r.root, '.mcp.json', JSON.stringify({ mcpServers: servers }));
    return r;
  };
  return { base, reg, code, repo, registry: () => loadRegistry(reg).registry, state: State.load(join(base, 'state')) };
}

describe('importing many repositories', () => {
  it('finds hand-written configs and skips files loadout generated', () => {
    const { code, repo, registry, state } = setup();
    const a = repo('a', { linkup: { url: 'https://mcp.linkup.so/mcp?apiKey=k' } });
    repo('b', { db: pg('b_db') });
    gitRepo(join(code, 'plain'), 'git@github.com:acme/plain.git'); // no MCP config
    expect(findImportCandidates(registry(), [code], state).map((c) => [c.repo.id, c.servers])).toEqual([
      ['github.com/acme/a', ['linkup']],
      ['github.com/acme/b', ['db']],
    ]);

    importRepo(registry(), a, { state });
    syncRepo(registry(), a, ['claude-code'], state, { force: true });
    expect(findImportCandidates(registry(), [code], state).map((c) => c.repo.id)).toEqual(['github.com/acme/b']);
  });

  it('reuses identical servers, replaces unused seeds, and keeps conflicting ones per repository', () => {
    const { reg, repo, registry, state } = setup();
    const a = repo('a', { linkup: { url: 'https://mcp.linkup.so/mcp?apiKey=k1' }, db: pg('a_db') });
    const b = repo('b', { linkup: { url: 'https://mcp.linkup.so/mcp?apiKey=k2' }, db: pg('b_db') });
    const session = new ImportSession(registry(), { state });

    const ra = importRepo(registry(), a, { session });
    expect(ra).toMatchObject({ created: ['db'], replaced: ['linkup'], own: [], attached: ['linkup', 'db'] });
    expect(readFileSync(join(reg, 'servers/linkup.yaml'), 'utf8')).toContain('description: Web search'); // seed description kept

    const rb = importRepo(loadRegistry(reg).registry, b, { session });
    expect(rb).toMatchObject({ reused: ['linkup'], own: ['db'], attached: ['linkup'] });
    expect(rb.notes.join()).toMatch(/db: differs from the shared definition used by github.com\/acme\/a/);

    // Each repository keeps exactly the configuration it had.
    const args = (repoCtx: typeof a) => {
      const db = resolveRepo(registry(), repoCtx).find((s) => s.name === 'db')!.transport;
      return db.type === 'stdio' ? db.args.map((v) => v.map((p) => (p.kind === 'text' ? p.value : '')).join('')).join(' ') : '';
    };
    expect(args(a)).toContain('a_db');
    expect(args(b)).toContain('b_db');
    expect(loadRegistry(reg).problems).toEqual([]);
  });

  it('a dry run over many repositories writes nothing but plans as if it had', () => {
    const { reg, repo, registry, state } = setup();
    const a = repo('a', { db: pg('same') });
    const b = repo('b', { db: pg('same') });
    const session = new ImportSession(registry(), { state, dryRun: true });
    expect(importRepo(registry(), a, { session })).toMatchObject({ created: ['db'], attached: ['db'] });
    expect(importRepo(registry(), b, { session })).toMatchObject({ reused: ['db'], attached: ['db'] });
    expect(readFileSync(join(reg, 'bindings.yaml'), 'utf8')).toBe('repositories: {}\n');
    writeFileSync(join(reg, 'unused'), '');
  });
});
