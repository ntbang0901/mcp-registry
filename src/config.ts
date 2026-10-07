import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import YAML from 'yaml';
import { ADAPTER_IDS, type AdapterId } from './adapters/index.js';
import { LoadoutError } from './errors.js';

export interface Config {
  registry?: string;
  workspaces: string[];
  targets: AdapterId[];
}

export const DEFAULT_TARGETS: AdapterId[] = ['claude-code', 'cursor'];

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

export function configPath(): string {
  if (process.env.LOADOUT_CONFIG) return resolve(process.env.LOADOUT_CONFIG);
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'loadout', 'config.yaml');
}

export function stateDir(): string {
  if (process.env.LOADOUT_STATE_DIR) return resolve(process.env.LOADOUT_STATE_DIR);
  const base = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(base, 'loadout');
}

export function parseTargets(raw: unknown, source: string): AdapterId[] {
  const list = typeof raw === 'string' ? raw.split(',').map((s) => s.trim()).filter(Boolean) : raw;
  if (!Array.isArray(list) || list.length === 0) {
    throw new LoadoutError(`${source}: targets must be a non-empty list`);
  }
  for (const t of list) {
    if (!(ADAPTER_IDS as readonly string[]).includes(t)) {
      throw new LoadoutError(`${source}: unknown target "${t}" (supported: ${ADAPTER_IDS.join(', ')})`);
    }
  }
  return list as AdapterId[];
}

export function loadConfig(): Config {
  const file = configPath();
  if (!existsSync(file)) return { workspaces: [], targets: [...DEFAULT_TARGETS] };
  const raw = (YAML.parse(readFileSync(file, 'utf8')) ?? {}) as Record<string, unknown>;
  const workspaces = raw.workspaces ?? [];
  if (!Array.isArray(workspaces) || workspaces.some((w) => typeof w !== 'string')) {
    throw new LoadoutError(`${file}: workspaces must be a list of paths`);
  }
  if (raw.registry !== undefined && typeof raw.registry !== 'string') {
    throw new LoadoutError(`${file}: registry must be a path`);
  }
  return {
    registry: raw.registry ? resolve(expandHome(raw.registry)) : undefined,
    workspaces: (workspaces as string[]).map((w) => resolve(expandHome(w))),
    targets: raw.targets === undefined ? [...DEFAULT_TARGETS] : parseTargets(raw.targets, file),
  };
}

export function saveConfig(config: Config): string {
  const file = configPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, YAML.stringify(config));
  return file;
}

/** Registry root: --registry flag > $LOADOUT_REGISTRY > config file. */
export function resolveRegistryRoot(flag: string | undefined, config: Config): string {
  const root = flag ?? process.env.LOADOUT_REGISTRY ?? config.registry;
  if (!root) {
    throw new LoadoutError('No registry configured. Run: loadout init --registry <path-to-registry-clone>');
  }
  return resolve(expandHome(root));
}
