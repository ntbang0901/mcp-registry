import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gitExcludePath } from './repo.js';

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Remembers the hash of every file loadout wrote, so it can tell its own output
 * (safe to overwrite) from a hand-written or hand-edited file (refuse unless --force).
 */
export class State {
  private files: Record<string, string> = {};
  constructor(private readonly path: string) {
    if (existsSync(path)) {
      try {
        this.files = JSON.parse(readFileSync(path, 'utf8')).files ?? {};
      } catch {
        this.files = {};
      }
    }
  }
  static load(dir: string) {
    return new State(join(dir, 'state.json'));
  }
  owns(file: string, content: string) {
    return this.files[file] === sha256(content);
  }
  record(file: string, content: string) {
    this.files[file] = sha256(content);
  }
  forget(file: string) {
    delete this.files[file];
  }
  save() {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify({ version: 1, files: this.files }, null, 2) + '\n');
  }
}

export type Outcome =
  | 'created'
  | 'updated'
  | 'unchanged'
  | 'replaced' // hand-written file overwritten with --force (backup kept)
  | 'conflict' // hand-written file, not touched
  | 'removed'
  | 'kept' // nothing to generate, but a hand-written file exists
  | 'absent';

export type FileStatus = 'ok' | 'missing' | 'stale' | 'modified' | 'orphan' | 'none';

/** What applyFile would do, without side effects. */
export function inspectFile(file: string, desired: string | null, state: State): FileStatus {
  const exists = existsSync(file);
  if (desired === null) {
    if (!exists) return 'none';
    return state.owns(file, readFileSync(file, 'utf8')) ? 'orphan' : 'none';
  }
  if (!exists) return 'missing';
  const current = readFileSync(file, 'utf8');
  if (current === desired) return 'ok';
  return state.owns(file, current) ? 'stale' : 'modified';
}

export function applyFile(
  file: string,
  desired: string | null,
  state: State,
  opts: { force?: boolean; dryRun?: boolean },
): Outcome {
  const exists = existsSync(file);
  const current = exists ? readFileSync(file, 'utf8') : undefined;
  const write = () => {
    if (opts.dryRun) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, desired!);
    state.record(file, desired!);
  };
  if (desired === null) {
    if (current === undefined) return 'absent';
    if (!state.owns(file, current)) return 'kept';
    if (!opts.dryRun) {
      rmSync(file);
      state.forget(file);
      try {
        rmdirSync(dirname(file)); // e.g. .cursor/, only if now empty
      } catch {
        /* not empty */
      }
    }
    return 'removed';
  }
  if (current === undefined) {
    write();
    return 'created';
  }
  if (current === desired) {
    if (!opts.dryRun) state.record(file, desired);
    return 'unchanged';
  }
  if (state.owns(file, current)) {
    write();
    return 'updated';
  }
  if (!opts.force) return 'conflict';
  if (!opts.dryRun) copyFileSync(file, `${file}.bak`);
  write();
  return 'replaced';
}

const EXCLUDE_HEADER = '# loadout: generated MCP client configs';

/** Ignore generated files via .git/info/exclude, so the repository itself needs no change. */
export function ensureExcluded(root: string, relPaths: string[], dryRun = false): string[] {
  const file = gitExcludePath(root);
  if (!file) return [];
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const lines = new Set(current.split('\n').map((l) => l.trim()));
  const missing = relPaths.map((p) => `/${p}`).filter((p) => !lines.has(p));
  if (missing.length && !dryRun) {
    const prefix = current && !current.endsWith('\n') ? '\n' : '';
    const header = lines.has(EXCLUDE_HEADER) ? '' : `${EXCLUDE_HEADER}\n`;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, current + prefix + header + missing.join('\n') + '\n');
  }
  return missing;
}
