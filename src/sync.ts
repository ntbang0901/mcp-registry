import { join } from 'node:path';
import { ADAPTERS, type AdapterId } from './adapters/index.js';
import { LoadoutError } from './errors.js';
import type { Registry } from './registry.js';
import { isTracked } from './repo.js';
import { resolveServer, secretEnvNames } from './resolve.js';
import type { RepoContext, ResolvedServer } from './types.js';
import { applyFile, ensureExcluded, inspectFile, type FileStatus, type Outcome, type State } from './writer.js';

export function resolveRepo(registry: Registry, repo: RepoContext): ResolvedServer[] {
  const bindings = registry.bindings.get(repo.id);
  if (!bindings) {
    throw new LoadoutError(
      `${repo.id} is not in ${registry.bindingsPath}.\n` +
        `  Attach servers with: loadout attach <server...>   or import existing configs with: loadout import`,
    );
  }
  return bindings.map((b) => {
    try {
      return resolveServer(registry.servers.get(b.server)!, b, repo);
    } catch (e) {
      throw new LoadoutError(`${repo.id} → ${b.server}: ${(e as Error).message}`);
    }
  });
}

export function desiredFiles(servers: ResolvedServer[], targets: AdapterId[]) {
  return targets.map((id) => {
    const adapter = ADAPTERS[id];
    return { target: id, path: adapter.path, content: servers.length ? adapter.render(servers) : null };
  });
}

export interface FileResult {
  path: string;
  outcome: Outcome;
  tracked: boolean;
}

export interface SyncResult {
  repo: RepoContext;
  servers: string[];
  files: FileResult[];
  /** Secret env vars the generated configs read, and which of them are missing in this shell. */
  envVars: string[];
  missingEnv: string[];
}

export function syncRepo(
  registry: Registry,
  repo: RepoContext,
  targets: AdapterId[],
  state: State,
  opts: { force?: boolean; dryRun?: boolean },
): SyncResult {
  const servers = resolveRepo(registry, repo);
  const files: FileResult[] = [];
  const written: string[] = [];
  for (const f of desiredFiles(servers, targets)) {
    const outcome = applyFile(join(repo.root, f.path), f.content, state, opts);
    if (['created', 'updated', 'unchanged', 'replaced'].includes(outcome)) written.push(f.path);
    // The backup of a hand-written file may hold a plaintext secret: never let git pick it up.
    if (outcome === 'replaced') written.push(`${f.path}.bak`);
    files.push({ path: f.path, outcome, tracked: outcome !== 'absent' && isTracked(repo.root, f.path) });
  }
  ensureExcluded(repo.root, written, opts.dryRun);
  const envVars = [...new Set(servers.flatMap(secretEnvNames))].sort();
  return {
    repo,
    servers: servers.map((s) => s.name),
    files,
    envVars,
    missingEnv: envVars.filter((n) => !process.env[n]),
  };
}

export interface StatusResult {
  repo: RepoContext;
  files: Array<{ path: string; status: FileStatus; tracked: boolean }>;
}

export function repoStatus(registry: Registry, repo: RepoContext, targets: AdapterId[], state: State): StatusResult {
  const servers = resolveRepo(registry, repo);
  return {
    repo,
    files: desiredFiles(servers, targets).map((f) => ({
      path: f.path,
      status: inspectFile(join(repo.root, f.path), f.content, state),
      tracked: isTracked(repo.root, f.path),
    })),
  };
}
