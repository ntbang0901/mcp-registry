import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

// Each test gets a throwaway registry (copy of this repo's servers/) and a workspace with two git repositories.
let tmp: string;
let ui: ChildProcess;
let url: string;

/** Contents of a generated file, or '' while it does not exist yet (so expect.poll keeps waiting). */
const repoFile = (repo: string, file: string) => {
  try {
    return readFileSync(join(tmp, 'code', repo, file), 'utf8');
  } catch {
    return '';
  }
};

test.beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'loadout-e2e-'));
  const registry = join(tmp, 'registry');
  cpSync('servers', join(registry, 'servers'), { recursive: true });
  cpSync('schemas', join(registry, 'schemas'), { recursive: true });
  writeFileSync(join(registry, 'bindings.yaml'), 'repositories:\n  github.com/acme/api: [linkup]\n');
  for (const name of ['api', 'web']) {
    const dir = join(tmp, 'code', name);
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['-C', dir, 'init', '-q']);
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', `https://github.com/acme/${name}.git`]);
  }
  writeFileSync(join(tmp, 'config.yaml'), `registry: ${registry}\nworkspaces: [${join(tmp, 'code')}]\n`);
  ui = spawn(process.execPath, ['dist/cli.js', 'ui', '--port', '0', '--no-open'], {
    env: { ...process.env, LOADOUT_CONFIG: join(tmp, 'config.yaml'), LOADOUT_STATE_DIR: join(tmp, 'state'), LINKUP_API_KEY: 'x' },
  });
  url = await new Promise<string>((resolve, reject) => {
    let out = '';
    ui.stdout!.on('data', (d) => {
      out += d;
      const m = /http:\/\/127\.0\.0\.1:\d+\/\?token=\w+/.exec(out);
      if (m) resolve(m[0]);
    });
    ui.on('exit', (code) => reject(new Error(`loadout ui exited with ${code}: ${out}`)));
  });
});

test.afterEach(() => {
  ui.kill();
});

test('adds a server with a per-repository value and generates each repository config', async ({ page }) => {
  await page.goto(`${url}#/repo/github.com/acme/api`);
  await expect(page.getByRole('heading', { name: /acme\/api/ })).toBeVisible();

  await page.getByRole('button', { name: '+ Add server' }).click();
  await page.getByRole('menuitem', { name: /New server/ }).click();
  await page.getByRole('button', { name: 'Fill in a form' }).click();
  await page.fill('#f-name', 'postgres');
  await page.getByLabel('Local command').check();
  await page.fill('#f-cmd', 'npx -y @acme/pg-mcp@1.0.0 --database {{ params.database }}');
  await expect(page.locator('#preview pre')).toContainText('required: true');
  await expect(page.locator('#attach-list input[value="github.com/acme/api"]')).toBeChecked();
  await page.getByRole('button', { name: 'Add server', exact: true }).click();

  // The server needs a value before it is added to the repository.
  const pending = page.locator('.srv.pending');
  await expect(pending).toBeVisible();
  await pending.locator('input[name=database]').fill('api_db');
  await pending.getByRole('button', { name: 'Add to repository' }).click();
  await expect(pending).toHaveCount(0);
  await expect.poll(() => repoFile('api', '.mcp.json')).toContain('api_db');

  // A second repository, found on disk but not registered yet, uses the same definition with its own value.
  await page.locator('#repo-nav').getByText('acme/api').click(); // any page; go back to the overview
  await page.getByRole('link', { name: 'Overview' }).click();
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('heading', { name: /acme\/web/ })).toBeVisible();
  await page.getByRole('button', { name: '+ Add server' }).click();
  await page.getByRole('menuitem', { name: /postgres/ }).click();
  await page.locator('.srv.pending input[name=database]').fill('web_db');
  await page.getByRole('button', { name: 'Add to repository' }).click();
  await expect.poll(() => repoFile('web', '.mcp.json')).toContain('web_db');
  expect(repoFile('api', '.mcp.json')).not.toContain('web_db');
});

test('a pasted API key is replaced by an environment variable and never saved', async ({ page }) => {
  await page.goto(url);
  await page.locator('#new-server-btn').click(); // sidebar "+", possibly before the first load completes
  await page.fill('#paste-text', '{"mcpServers":{"tavily":{"url":"https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-E2E-SECRET"}}}');
  await expect(page.locator('#preview pre')).toContainText('TAVILY_API_KEY');
  await expect(page.locator('#preview')).not.toContainText('tvly-E2E-SECRET');
  await page.getByRole('button', { name: 'Add server', exact: true }).click();
  await expect(page.locator('#server-nav')).toContainText('tavily');
  const saved = readdirSync(join(tmp, 'registry', 'servers')).map((f) =>
    readFileSync(join(tmp, 'registry', 'servers', f), 'utf8'),
  );
  expect(saved.join('\n')).not.toContain('tvly-E2E-SECRET');
});

test('overview reports work to do and fits a phone screen', async ({ page }) => {
  await page.goto(url);
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.getByText('github.com/acme/api is out of sync')).toBeVisible();
  await expect(page.getByText('github.com/acme/web', { exact: true })).toBeVisible(); // found on disk, not registered
  await page.getByRole('button', { name: 'Sync', exact: true }).click();
  await expect(page.getByText('Everything is in sync.')).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('imports every hand-written MCP config found in the workspace', async ({ page }) => {
  for (const [name, db] of [['web', 'web_db']] as const) {
    writeFileSync(
      join(tmp, 'code', name, '.mcp.json'),
      JSON.stringify({ mcpServers: { db: { command: 'npx', args: ['-y', '@acme/db-mcp@2.0.0', '--db', db] } } }),
    );
  }
  await page.goto(url);
  const section = page.locator('.section', { hasText: 'MCP configs to import' });
  await expect(section).toContainText('github.com/acme/web');
  await expect(section).toContainText('db');
  await section.getByRole('button', { name: 'Import', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: /acme\/web/ })).toBeVisible();
  await expect.poll(() => repoFile('web', '.mcp.json')).toContain('"db"');
  expect(repoFile('web', '.mcp.json.bak')).toContain('web_db');
});

test('scans a folder of projects that are not git repositories', async ({ page }) => {
  const folder = join(tmp, 'elsewhere');
  mkdirSync(join(folder, 'notebook'), { recursive: true });
  writeFileSync(
    join(folder, 'notebook', '.mcp.json'),
    JSON.stringify({ mcpServers: { docs: { url: 'https://docs.example.com/mcp' } } }),
  );
  await page.goto(url);
  await page.getByLabel('Folder that contains your projects').fill(folder);
  await page.getByRole('button', { name: 'Scan', exact: true }).click();
  const section = page.locator('.section', { hasText: 'MCP configs to import' });
  await expect(section).toContainText('local/notebook');
  await section.getByRole('button', { name: 'Import', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: /notebook/ })).toBeVisible();
  await expect(page.locator('.chip', { hasText: folder })).toHaveCount(0); // chips live on the overview
  await page.getByRole('link', { name: 'Overview' }).click();
  await expect(page.locator('.chip', { hasText: folder })).toBeVisible();
});
