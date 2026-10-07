import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commitAdd, makeRepoOnly, previewAdd, removeServer, shareServer } from '../src/add.js';
import { importRepo } from '../src/importer.js';
import { knownRepos, loadRegistry } from '../src/registry.js';
import { detectRepo } from '../src/repo.js';
import { resolveRepo } from '../src/sync.js';
import { ctx, gitRepo, tmp, write } from './helpers.js';

const LINKUP = 'name: linkup\ntransport: { type: http, url: https://mcp.linkup.so/mcp }\n';
const DB = 'name: db\ntransport: { type: stdio, command: node, args: ["{{ repo.root }}/tools/db-mcp.js"] }\n';

function setup(extra: Record<string, string> = {}) {
  const root = tmp();
  write(root, 'servers/linkup.yaml', LINKUP);
  write(root, 'bindings.yaml', 'repositories:\n  github.com/acme/app: [linkup]\n');
  for (const [rel, content] of Object.entries(extra)) write(root, rel, content);
  return { root, registry: () => loadRegistry(root).registry, problems: () => loadRegistry(root).problems };
}

describe('repository-only servers', () => {
  it('load from repos/<id>/, count as known repos, and resolve after shared bindings', () => {
    const { registry, problems } = setup({
      'repos/github.com/acme/app/db.yaml': DB,
      'repos/github.com/acme/other/db.yaml': DB.replace('db-mcp.js', 'other.js'),
    });
    expect(problems()).toEqual([]);
    const r = registry();
    expect(knownRepos(r)).toEqual(['github.com/acme/app', 'github.com/acme/other']);
    const servers = resolveRepo(r, ctx('github.com/acme/app', '/w/app'));
    expect(servers.map((s) => s.name)).toEqual(['linkup', 'db']);
    const db = servers[1].transport;
    expect(db.type === 'stdio' && db.args[0]).toEqual([{ kind: 'text', value: '/w/app/tools/db-mcp.js' }]);
    expect(resolveRepo(r, ctx('github.com/acme/other', '/w/other')).map((s) => s.name)).toEqual(['db']);
  });

  it('reports clashes with attached shared servers and non-normalized directories', () => {
    const { problems } = setup({
      'repos/github.com/acme/app/linkup.yaml': LINKUP,
      'repos/GitHub.com/Acme/X/db.yaml': DB,
      'repos/stray.yaml': DB,
    });
    const all = problems()
      .map((p) => `${p.file}: ${p.message}`)
      .join('\n');
    expect(all).toMatch(/linkup: clashes with the repository's own/);
    expect(all).toMatch(/directory must be the normalized repository id: repos\/github.com\/acme\/x\//);
    expect(all).toMatch(/repos\/stray.yaml: must be inside repos\/<host>\/<owner>\/<name>\//);
  });

  it('can be added, shared, made repo-only again and removed', () => {
    const { root, registry, problems } = setup();
    const preview = previewAdd(registry(), [{ name: 'db', cfg: { command: 'node', args: ['/w/app/tools/db.js'] } }], {
      repo: 'github.com/acme/app',
      root: '/w/app',
    });
    expect(preview.servers[0].path).toBe('repos/github.com/acme/app/db.yaml');
    expect(preview.servers[0].yaml).toContain('$schema=../../../../schemas/server.schema.json');
    expect(preview.servers[0].yaml).toContain('{{ repo.root }}/tools/db.js');
    commitAdd(registry(), preview);
    expect(problems()).toEqual([]);

    // a repo-only server may not take the name of a shared server the repo already uses
    const clash = previewAdd(registry(), [{ name: 'linkup', cfg: { url: 'https://x' } }], { repo: 'github.com/acme/app' });
    expect(clash.servers[0].problems.map((p) => p.message).join()).toMatch(/already uses the shared server "linkup"/);

    shareServer(registry(), 'github.com/acme/app', 'db');
    expect(existsSync(join(root, 'repos'))).toBe(false); // empty directories pruned
    expect(readFileSync(join(root, 'servers/db.yaml'), 'utf8')).toMatch(
      /^# yaml-language-server: \$schema=..\/schemas\/server.schema.json\n/,
    );
    expect(
      registry()
        .bindings.get('github.com/acme/app')!
        .map((b) => b.server),
    ).toEqual(['linkup', 'db']);
    expect(problems()).toEqual([]);

    expect(makeRepoOnly(registry(), 'db')).toBe('github.com/acme/app');
    expect(
      registry()
        .bindings.get('github.com/acme/app')!
        .map((b) => b.server),
    ).toEqual(['linkup']);
    expect(registry().repoServers.get('github.com/acme/app')!.has('db')).toBe(true);

    removeServer(registry(), 'db', 'github.com/acme/app');
    expect(registry().repoServers.size).toBe(0);
  });

  it('refuses to make a server used by several repositories repo-only', () => {
    const { registry } = setup({
      'bindings.yaml': 'repositories:\n  github.com/acme/a: [linkup]\n  github.com/acme/b: [linkup]\n',
    });
    expect(() => makeRepoOnly(registry(), 'linkup')).toThrow(/used by 2 repositories/);
  });

  it('imports a repository config as repo-only servers', () => {
    const { root, registry } = setup();
    const base = tmp();
    const repo = detectRepo(gitRepo(join(base, 'svc'), 'git@github.com:acme/svc.git'));
    write(repo.root, '.mcp.json', JSON.stringify({ mcpServers: { tools: { command: 'node', args: [`${repo.root}/mcp.js`] } } }));
    const r = importRepo(registry(), repo, { repoOnly: true });
    expect(r).toMatchObject({ own: ['tools'], attached: [] });
    expect(readFileSync(join(root, 'repos/github.com/acme/svc/tools.yaml'), 'utf8')).toContain('{{ repo.root }}/mcp.js');
    expect(readFileSync(join(root, 'bindings.yaml'), 'utf8')).not.toContain('acme/svc');
    expect(resolveRepo(registry(), repo).map((s) => s.name)).toEqual(['tools']);
  });
});
