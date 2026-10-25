import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const root = process.cwd();
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForReady(baseUrl, child, logs) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Development edge exited early: ${logs()}`);
    try {
      const response = await fetch(`${baseUrl}/api/ready`);
      if (response.ok) return;
    } catch { /* The edge may still be opening its temporary SQLite file. */ }
    await delay(100);
  }
  throw new Error(`Development edge did not become ready: ${logs()}`);
}

test('development edge bootstraps the local POS without Supabase credentials', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'common-table-dev-session-'));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let output = '';
  const child = spawn(process.execPath, ['apps/server/dist/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'development', PORT: String(port), POS_DATABASE_PATH: join(directory, 'edge.sqlite'),
      POS_TENANT_ID: 'dev-tenant', POS_TENANT_NAME: 'Development Cafe', POS_OUTLET_ID: 'dev-outlet',
      POS_OUTLET_NAME: 'Development Outlet', POS_TERMINAL_ID: 'dev-terminal', POS_TERMINAL_NAME: 'Counter 1',
      POS_TAX_RATE_BPS: '0', POS_CURRENCY: 'USD', MOCK_PRINTER_HOST: '127.0.0.1', MOCK_PRINTER_PORT: '0',
      VITE_SUPABASE_URL: '', VITE_SUPABASE_PUBLISHABLE_KEY: '', POS_SESSION_SECRET: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-3000); });
  child.stderr.on('data', chunk => { output = (output + chunk.toString()).slice(-3000); });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(2500)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    await rm(directory, { recursive: true, force: true });
  });

  await waitForReady(baseUrl, child, () => output);
  const sessionResponse = await fetch(`${baseUrl}/api/auth/session`);
  assert.equal(sessionResponse.status, 200);
  assert.match(sessionResponse.headers.get('set-cookie') ?? '', /HttpOnly/);
  const session = await sessionResponse.json();
  assert.equal(session.role, 'owner');
  assert.equal(session.displayName, 'Local development');

  const orderResponse = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: randomUUID(), tenantId: 'dev-tenant', outletId: 'dev-outlet', terminalId: 'dev-terminal',
      orderType: 'takeaway', guestCount: 1, lines: [{ menuItemId: 'indori-poha', quantity: 1 }] }),
  });
  assert.equal(orderResponse.status, 201);
  const order = await orderResponse.json();
  assert.equal(order.lines[0].name, 'Indori Poha');
  assert.equal(order.currency, 'USD');
  assert.equal(order.status, 'sent');
});
