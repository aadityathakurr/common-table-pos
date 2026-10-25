import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('normal server start forces production auth and rejects missing outlet configuration', () => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('POS_') || key === 'NODE_ENV') delete env[key];
  }
  const result = spawnSync(process.execPath, ['scripts/start-production.mjs'], {
    cwd: serverRoot,
    env,
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.notEqual(result.status, 0, 'a production cashier server must not start with demo defaults');
  assert.match(`${result.stdout}\n${result.stderr}`, /Missing required environment variable: POS_TENANT_ID/);
});
