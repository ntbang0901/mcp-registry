// Smoke test of an installed `loadout` (e.g. from the packed tarball): the steps a new user runs.
// Usage: node scripts/smoke.mjs [registry-git-url-or-path]           (uses the local dist/cli.js build)
//        LOADOUT_BIN=$(which loadout) node scripts/smoke.mjs .     (an installed loadout, e.g. from the tarball)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const bin = process.env.LOADOUT_BIN || new URL('../dist/cli.js', import.meta.url).pathname;
const source = process.argv[2] || '.';
// A git URL (https://…, git@host:…) is passed through; anything else is a local path.
const registrySource = /^[\w+-]+:\/\/|^[\w.-]+@[^:]+:/.test(source) ? source : resolve(source);
const tmp = mkdtempSync(join(tmpdir(), 'loadout-smoke-'));
const env = {
  ...process.env,
  LOADOUT_CONFIG: join(tmp, 'config.yaml'),
  LOADOUT_STATE_DIR: join(tmp, 'state'),
  XDG_DATA_HOME: join(tmp, 'share'),
  LINKUP_API_KEY: 'smoke',
};
let failures = 0;

function run(args, { cwd = tmp, expectFail = false } = {}) {
  try {
    // A built-but-not-installed dist/cli.js has no exec bit: run it through node.
    const [cmd, argv] = bin.endsWith('.js') ? [process.execPath, [bin, ...args]] : [bin, args];
    const out = execFileSync(cmd, argv, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (expectFail) throw new Error(`expected failure: loadout ${args.join(' ')}`);
    return out;
  } catch (e) {
    if (expectFail && e.status) return `${e.stdout}${e.stderr}`;
    throw new Error(`loadout ${args.join(' ')} failed:\n${e.stdout ?? ''}${e.stderr ?? e.message}`);
  }
}

function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `\n     ${detail}`}`);
  if (!ok) failures++;
}

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });

// A repository with a hand-written, committed MCP config that contains a real-looking key.
const code = join(tmp, 'code');
const app = join(code, 'app');
mkdirSync(app, { recursive: true });
git(app, 'init', '-q');
git(app, 'remote', 'add', 'origin', 'git@github.com:acme/app.git');
writeFileSync(
  join(app, '.mcp.json'),
  JSON.stringify({
    mcpServers: {
      context7: { type: 'http', url: 'https://mcp.context7.com/mcp' },
      linkup: { type: 'http', url: 'https://mcp.linkup.so/mcp?apiKey=lk-SMOKE-SECRET' },
    },
  }),
);

check('--version', /^\d+\.\d+\.\d+/.test(run(['--version'])));

run(['init', '--from', registrySource, '--workspace', code]);
const registry = join(tmp, 'share', 'loadout', 'registry');
check('init --from clones the registry', existsSync(join(registry, 'servers')));
check('validate', /0 error\(s\)/.test(run(['validate'])));

const imported = run(['import'], { cwd: app });
check('import attaches the servers', /attached:\s+context7, linkup/.test(imported), imported);

const synced = run(['sync', '--force'], { cwd: app });
const mcp = readFileSync(join(app, '.mcp.json'), 'utf8');
check('sync replaces the hand-written file', /replaced/.test(synced), synced);
check('generated config reads the key from the environment', mcp.includes('${LINKUP_API_KEY}') && !mcp.includes('lk-SMOKE'), mcp);
check('cursor config generated', existsSync(join(app, '.cursor', 'mcp.json')));
check('generated files are git-excluded', readFileSync(join(app, '.git', 'info', 'exclude'), 'utf8').includes('/.mcp.json'));
check('status is clean', /up to date/.test(run(['status'], { cwd: app })));

const leaked = readdirSync(join(registry, 'servers')).some((f) =>
  readFileSync(join(registry, 'servers', f), 'utf8').includes('lk-SMOKE-SECRET'),
);
check(
  'the API key never reaches the registry',
  !leaked && !readFileSync(join(registry, 'bindings.yaml'), 'utf8').includes('lk-SMOKE'),
);

const added = run(['add', 'pg', '--', 'npx', '-y', '@acme/pg-mcp@1.0.0', '--db', '{{ params.db }}']);
check('add declares placeholders as params', /db:\n\s+type: string\n\s+required: true/.test(added), added);
const refused = run(['attach', 'pg'], { cwd: app, expectFail: true });
check('attach refuses a server with missing required values', /needs values for db/.test(refused), refused);
run(['set', 'pg', 'db=app_db', '--attach'], { cwd: app });
check('set --attach fills the value and syncs', readFileSync(join(app, '.mcp.json'), 'utf8').includes('app_db'));
check('registry still valid', /0 error\(s\)/.test(run(['validate'])));

// Bulk import: two more repositories with hand-written configs, found by scanning the workspace.
for (const [name, db] of [
  ['svc-a', 'a_db'],
  ['svc-b', 'b_db'],
]) {
  const dir = join(code, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'remote', 'add', 'origin', `git@github.com:acme/${name}.git`);
  writeFileSync(
    join(dir, '.mcp.json'),
    JSON.stringify({ mcpServers: { db: { command: 'npx', args: ['-y', '@acme/db-mcp@2.0.0', '--db', db] } } }),
  );
}
const planned = run(['import', '--all', '--dry-run']);
check(
  'import --all finds every hand-written config',
  /acme\/svc-a/.test(planned) && /acme\/svc-b/.test(planned) && !/acme\/app\b/.test(planned),
  planned,
);
const bulk = run(['import', '--all', '--sync']);
check('conflicting definitions stay per repository', /own:\s+db/.test(bulk), bulk);
check(
  'bulk import generates each config',
  readFileSync(join(code, 'svc-a', '.mcp.json'), 'utf8').includes('a_db') &&
    readFileSync(join(code, 'svc-b', '.mcp.json'), 'utf8').includes('b_db'),
);
check('nothing left to import', /No hand-written MCP configs/.test(run(['import', '--all'])));
check('registry valid after bulk import', /0 error\(s\)/.test(run(['validate'])));

console.log(failures ? `\n${failures} check(s) failed` : '\nall smoke checks passed');
process.exit(failures ? 1 : 0);
