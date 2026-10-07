import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commitAdd, entryFromForm, parsePairs, parseServerJson, previewAdd, removeServer, splitCommandLine } from '../src/add.js';
import { loadRegistry } from '../src/registry.js';
import { tmp, write } from './helpers.js';

describe('parseServerJson', () => {
  it.each([
    ['client config', '{"mcpServers":{"a":{"url":"https://a"},"b":{"command":"x"}}}', ['a', 'b']],
    ['VS Code config', '{"servers":{"a":{"type":"http","url":"https://a"}}}', ['a']],
    ['map of entries', '{"a":{"url":"https://a"}}', ['a']],
    ['README fragment', '"a": {"command": "npx", "args": []},', ['a']],
    ['single entry', '{"command":"npx"}', [undefined]],
  ])('%s', (_label, text, names) => {
    expect(parseServerJson(text).map((e) => e.name)).toEqual(names);
  });

  it('rejects junk', () => {
    expect(() => parseServerJson('')).toThrow(/Nothing to add/);
    expect(() => parseServerJson('{nope')).toThrow(/Invalid JSON/);
    expect(() => parseServerJson('{"foo":1}')).toThrow(/No MCP server found/);
  });
});

describe('form helpers', () => {
  it('splits command lines with quotes', () => {
    expect(splitCommandLine(`npx -y "@a/b@1.0.0" --name 'my repo' a\\ b ""`)).toEqual([
      'npx',
      '-y',
      '@a/b@1.0.0',
      '--name',
      'my repo',
      'a b',
      '',
    ]);
    expect(() => splitCommandLine('npx "oops')).toThrow(/Unterminated/);
    expect(splitCommandLine('pg --db {{ params.database }} --url=x/{{ repo.name }}/y')).toEqual([
      'pg',
      '--db',
      '{{ params.database }}',
      '--url=x/{{ repo.name }}/y',
    ]);
  });

  it('parses KEY=value and Header: value pairs', () => {
    expect(parsePairs('A=1\n# comment\n\nAuthorization: Bearer x=y')).toEqual({ A: '1', Authorization: 'Bearer x=y' });
    expect(() => parsePairs('just text')).toThrow(/KEY=value/);
  });

  it('builds entries from the form', () => {
    expect(entryFromForm({ name: 'r', kind: 'remote', url: ' https://x ', pairs: 'K=v' }).cfg).toEqual({
      type: 'http',
      url: 'https://x',
      headers: { K: 'v' },
    });
    expect(entryFromForm({ name: 'c', kind: 'command', command: 'uvx pkg==1.0.0 --a' }).cfg).toEqual({
      command: 'uvx',
      args: ['pkg==1.0.0', '--a'],
    });
    expect(() => entryFromForm({ name: '', kind: 'remote', url: 'x' })).toThrow(/Name/);
    expect(() => entryFromForm({ name: 'r', kind: 'remote' })).toThrow(/URL/);
  });
});

describe('previewAdd / commitAdd / removeServer', () => {
  const setup = () => {
    const root = tmp();
    write(root, 'servers/linkup.yaml', 'name: linkup\ntransport: { type: http, url: https://mcp.linkup.so/mcp }\n');
    write(root, 'bindings.yaml', 'repositories:\n  github.com/acme/app: [linkup]\n');
    return { root, registry: () => loadRegistry(root).registry };
  };

  it('previews without secrets, writes valid files, refuses existing names unless overwrite', () => {
    const { root, registry } = setup();
    const preview = previewAdd(
      registry(),
      parseServerJson('{"mcpServers":{"Search":{"url":"https://s/mcp","headers":{"X-Api-Key":"live-123"}}}}'),
      {
        description: 'Search',
      },
    );
    expect(preview.servers[0]).toMatchObject({ name: 'search', exists: false, envVars: ['SEARCH_X_API_KEY'], problems: [] });
    expect(preview.servers[0].yaml).not.toContain('live-123');
    expect(preview.servers[0].yaml).toContain('description: Search');
    expect(commitAdd(registry(), preview)).toEqual(['search']);
    expect(loadRegistry(root).problems).toEqual([]);

    const again = previewAdd(registry(), [{ name: 'linkup', cfg: { url: 'https://other' } }]);
    expect(again.servers[0].exists).toBe(true);
    expect(() => commitAdd(registry(), again)).toThrow(/already exists/);
    commitAdd(registry(), again, { overwrite: true });
    expect(readFileSync(join(root, 'servers/linkup.yaml'), 'utf8')).toContain('https://other');
  });

  it('refuses invalid definitions and multiple names', () => {
    const { registry } = setup();
    const bad = previewAdd(registry(), [{ name: 'x', cfg: { command: 'npx', args: ['-y', 'pkg@latest'] } }]);
    expect(bad.servers[0].problems.map((p) => p.level)).toEqual(['warning']);
    expect(() =>
      previewAdd(registry(), parseServerJson('{"a":{"url":"https://a"},"b":{"url":"https://b"}}'), { name: 'n' }),
    ).toThrow(/single server/);
    expect(() => previewAdd(registry(), parseServerJson('{"command":"x"}'))).toThrow(/no server name/);
  });

  it('removes only unused servers', () => {
    const { root, registry } = setup();
    expect(() => removeServer(registry(), 'linkup')).toThrow(/still used by: github.com\/acme\/app/);
    commitAdd(registry(), previewAdd(registry(), [{ name: 'tmp', cfg: { url: 'https://t' } }]));
    removeServer(registry(), 'tmp');
    expect(existsSync(join(root, 'servers/tmp.yaml'))).toBe(false);
  });
});
