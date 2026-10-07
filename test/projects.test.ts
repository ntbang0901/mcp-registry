import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findImportCandidates, importRepo } from '../src/importer.js';
import { loadRegistry } from '../src/registry.js';
import { detectProject, findProjects, localProjectId, normalizeRepoId } from '../src/repo.js';
import { syncRepo } from '../src/sync.js';
import { State } from '../src/writer.js';
import { gitRepo, tmp, write } from './helpers.js';

const mcp = JSON.stringify({ mcpServers: { docs: { url: 'https://docs.example.com/mcp' } } });

function workspace() {
  const ws = tmp();
  gitRepo(join(ws, 'gh-app'), 'git@github.com:acme/gh-app.git'); // git + remote
  mkdirSync(join(ws, 'local-git'));
  execFileSync('git', ['init', '-q', join(ws, 'local-git')]); // git, no remote
  write(ws, 'clients/Acme API/.mcp.json', mcp); // plain folder with an MCP config, nested, with a space
  write(ws, 'notes/readme.md', 'not a project'); // plain folder without MCP config: ignored
  write(ws, 'web/node_modules/pkg/.mcp.json', mcp); // inside node_modules: ignored
  write(ws, 'tool/.cursor/mcp.json', mcp); // Cursor-only config
  return ws;
}

describe('projects without a GitHub remote', () => {
  it('accepts local ids', () => {
    expect(normalizeRepoId('local/clients/acme-api')).toBe('local/clients/acme-api');
  });

  it('identifies folders by their path inside the workspace', () => {
    expect(localProjectId('/w/clients/Acme API', ['/w'])).toBe('local/clients/acme-api');
    expect(localProjectId('/w/inner/x', ['/w', '/w/inner'])).toBe('local/x'); // deepest workspace wins
    expect(localProjectId('/elsewhere/My Tool', ['/w'])).toBe('local/my-tool'); // outside: folder name
  });

  it('finds git repositories (with or without remote) and plain folders with an MCP config', () => {
    const ws = workspace();
    expect(
      findProjects([ws])
        .map((p) => p.id)
        .sort(),
    ).toEqual(['github.com/acme/gh-app', 'local/clients/acme-api', 'local/local-git', 'local/tool']);
  });

  it('detects the project of a directory', () => {
    const ws = workspace();
    expect(detectProject(join(ws, 'gh-app'), [ws]).id).toBe('github.com/acme/gh-app');
    expect(detectProject(join(ws, 'local-git'), [ws]).id).toBe('local/local-git');
    expect(detectProject(join(ws, 'clients', 'Acme API'), [ws])).toMatchObject({
      id: 'local/clients/acme-api',
      name: 'acme-api',
    });
  });

  it('takes a picked folder that is itself a project', () => {
    const ws = workspace();
    expect(findProjects([join(ws, 'tool')], [ws]).map((p) => p.id)).toEqual(['local/tool']);
  });

  it('imports and syncs a plain folder like any repository', () => {
    const ws = workspace();
    const reg = tmp();
    write(reg, 'servers/.keep', '');
    write(reg, 'bindings.yaml', 'repositories: {}\n');
    const state = State.load(join(reg, 'state'));
    const registry = () => loadRegistry(reg).registry;
    const candidate = findImportCandidates(registry(), [ws], state).find((c) => c.repo.id === 'local/clients/acme-api')!;
    expect(candidate.servers).toEqual(['docs']);
    importRepo(registry(), candidate.repo, { state });
    expect(registry().bindings.get('local/clients/acme-api')).toEqual([{ server: 'docs', params: {} }]);
    const r = syncRepo(registry(), candidate.repo, ['claude-code', 'cursor'], state, { force: true });
    expect(r.files.map((f) => f.outcome)).toEqual(['replaced', 'created']);
    expect(existsSync(join(candidate.repo.root, '.cursor', 'mcp.json'))).toBe(true);
    expect(readFileSync(join(candidate.repo.root, '.mcp.json'), 'utf8')).toContain('docs.example.com');
    expect(loadRegistry(reg).problems).toEqual([]);
  });
});
