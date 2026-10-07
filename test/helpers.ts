import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { repoContext } from '../src/repo.js';

export const tmp = (prefix = 'loadout-') => mkdtempSync(join(tmpdir(), prefix));

export function write(root: string, rel: string, content: string) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

export function gitRepo(dir: string, remote: string) {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', remote]);
  return dir;
}

export const ctx = (id = 'github.com/acme/app', root = '/work/app') => repoContext(id, root);
