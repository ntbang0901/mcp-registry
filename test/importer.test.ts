import { describe, expect, it } from 'vitest';
import { convertEntry } from '../src/importer.js';
import { ctx } from './helpers.js';

const repo = ctx('github.com/acme/app', '/home/me/code/app').root;

describe('convertEntry', () => {
  it('moves a secret in the url query into a secret param and drops the value', () => {
    const { def, notes } = convertEntry('Linkup', { type: 'http', url: 'https://mcp.linkup.so/mcp?apiKey=sk-123&x=1' }, repo);
    expect(def.name).toBe('linkup');
    expect(def.transport).toEqual({ type: 'http', url: 'https://mcp.linkup.so/mcp?apiKey={{ params.LINKUP_API_KEY }}&x=1' });
    expect(def.params).toEqual({ LINKUP_API_KEY: { type: 'secret', default: 'env://LINKUP_API_KEY' } });
    expect(JSON.stringify(def)).not.toContain('sk-123');
    expect(notes.join('\n')).toMatch(/NOT copied — export LINKUP_API_KEY/);
  });

  it('keeps bearer prefixes and reuses existing env references', () => {
    const { def, notes } = convertEntry(
      'svc',
      { url: 'https://x', headers: { Authorization: 'Bearer ${env:SVC_KEY}', 'X-Trace': 'on' } },
      repo,
    );
    expect(def.transport).toEqual({ type: 'http', url: 'https://x', headers: { Authorization: 'Bearer {{ params.SVC_KEY }}', 'X-Trace': 'on' } });
    expect(notes.filter((n) => n.includes('NOT copied'))).toEqual([]);
  });

  it('detects pinned npx/uvx packages, secrets in env and args, and repo paths', () => {
    const { def } = convertEntry(
      'fs',
      {
        command: 'npx',
        args: ['-y', '@scope/fs@1.4.0', '/home/me/code/app', '--token', 'abc', 'apiKey=def', '${workspaceFolder}/src'],
        env: { GITHUB_TOKEN: 'ghp_x', LOG: 'info' },
      },
      repo,
    );
    expect(def.transport).toEqual({
      type: 'stdio',
      package: { registry: 'npm', name: '@scope/fs', version: '1.4.0' },
      args: ['{{ repo.root }}', '--token', '{{ params.FS_TOKEN }}', 'apiKey={{ params.FS_API_KEY }}', '{{ repo.root }}/src'],
      env: { GITHUB_TOKEN: '{{ params.GITHUB_TOKEN }}', LOG: 'info' },
    });
    expect(Object.keys(def.params!)).toEqual(['FS_TOKEN', 'FS_API_KEY', 'GITHUB_TOKEN']);
    expect(JSON.stringify(def)).not.toMatch(/abc|def"|ghp_x/);

    const py = convertEntry('cg', { command: 'uvx', args: ['code-graph-mcp==1.2.4', '--verbose'] }, repo).def;
    expect(py.transport).toEqual({ type: 'stdio', package: { registry: 'pypi', name: 'code-graph-mcp', version: '1.2.4' }, args: ['--verbose'] });
  });

  it('keeps unpinned packages as raw commands with a note', () => {
    const { def, notes } = convertEntry('x', { command: 'npx', args: ['-y', 'pkg@latest'] }, repo);
    expect(def.transport).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'pkg@latest'] });
    expect(notes.join()).toMatch(/not pinned/);
  });
});
