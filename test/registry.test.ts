import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { attachServers, detachServers } from '../src/bindings-edit.js';
import { loadRegistry } from '../src/registry.js';
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

function registry(files: Record<string, string>) {
  const root = tmp();
  for (const [rel, content] of Object.entries(files)) write(root, rel, content);
  return root;
}

const messages = (root: string) => loadRegistry(root).problems.map((p) => `${p.level}: ${p.message}`);

describe('loadRegistry', () => {
  it('loads servers and normalizes binding keys', () => {
    const root = registry({
      'servers/linkup.yaml': LINKUP,
      'bindings.yaml': 'repositories:\n  git@github.com:Acme/App.git: [linkup]\n',
    });
    const { registry: r, problems } = loadRegistry(root);
    expect(problems).toEqual([]);
    expect(r.bindings.get('github.com/acme/app')).toEqual([{ server: 'linkup', params: {} }]);
  });

  it('rejects unpinned package versions', () => {
    const root = registry({
      'servers/x.yaml': 'name: x\ntransport: { type: stdio, package: { registry: npm, name: x, version: latest } }\n',
    });
    expect(messages(root).join('\n')).toMatch(/version must match pattern/);
  });

  it('rejects plaintext secrets in headers, env and url queries', () => {
    const root = registry({
      'servers/a.yaml': 'name: a\ntransport: { type: http, url: "https://x?apiKey=abc", headers: { Authorization: "Bearer abc" } }\n',
      'servers/b.yaml': 'name: b\ntransport: { type: stdio, command: node, env: { GITHUB_TOKEN: ghp_x } }\n',
    });
    const all = messages(root).join('\n');
    expect(all).toMatch(/headers.Authorization looks like a plaintext secret/);
    expect(all).toMatch(/url query "apiKey" looks like a plaintext secret/);
    expect(all).toMatch(/env.GITHUB_TOKEN looks like a plaintext secret/);
  });

  it('reports name mismatches, undeclared params, unknown servers and bad bindings', () => {
    const root = registry({
      'servers/a.yaml': 'name: b\ntransport: { type: http, url: https://x }\n',
      'servers/c.yaml': 'name: c\ntransport: { type: http, url: "https://x/{{ params.nope }}" }\n',
      'servers/linkup.yaml': LINKUP,
      'bindings.yaml': 'repositories:\n  github.com/acme/app: [ghost]\n  github.com/acme/api:\n    linkup: { params: { apiKey: sk-live-123 } }\n',
    });
    const all = messages(root).join('\n');
    expect(all).toMatch(/name "b" must match the file name "a"/);
    expect(all).toMatch(/undeclared param "nope"/);
    expect(all).toMatch(/ghost: unknown server/);
    expect(all).toMatch(/linkup: Param "apiKey" .*not a secret reference/);
    expect(all).not.toContain('sk-live-123');
  });

  it('warns on raw npx commands', () => {
    const root = registry({ 'servers/x.yaml': 'name: x\ntransport: { type: stdio, command: npx, args: [-y, pkg] }\n' });
    expect(messages(root)).toEqual(['warning: command "npx" runs an unpinned package; use transport.package with an exact version']);
  });
});

describe('bindings editing', () => {
  it('attaches and detaches while preserving comments and style', () => {
    const root = registry({
      'bindings.yaml': '# my comment\nrepositories:\n  github.com/acme/app: [linkup] # inline\n',
    });
    const path = join(root, 'bindings.yaml');
    expect(attachServers(path, 'github.com/acme/app', ['context7', 'linkup'])).toEqual(['context7']);
    expect(attachServers(path, 'github.com/acme/new', ['linkup'])).toEqual(['linkup']);
    expect(readFileSync(path, 'utf8')).toBe(
      '# my comment\nrepositories:\n  github.com/acme/app: [linkup, context7] # inline\n  github.com/acme/new: [linkup]\n',
    );
    expect(detachServers(path, 'github.com/acme/app', ['linkup', 'context7', 'ghost'])).toEqual(['linkup', 'context7']);
    expect(readFileSync(path, 'utf8')).toContain('github.com/acme/app: [] # inline');
  });

  it('matches existing keys written as URLs and supports the map form', () => {
    const root = registry({
      'bindings.yaml': 'repositories:\n  https://github.com/Acme/App.git:\n    linkup:\n',
    });
    const path = join(root, 'bindings.yaml');
    expect(attachServers(path, 'github.com/acme/app', ['context7'])).toEqual(['context7']);
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('https://github.com/Acme/App.git:');
    expect(text).toMatch(/linkup:.*\n\s+context7:/);
  });
});
