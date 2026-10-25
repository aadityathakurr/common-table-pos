import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const root = process.cwd();
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const secret = 'test-only-session-secret-for-production-auth';

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForReady(baseUrl, child, readLogs) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Production-mode edge exited early: ${readLogs()}`);
    try {
      const response = await fetch(`${baseUrl}/api/ready`);
      if (response.ok) return;
    } catch { /* Wait for the server and temporary database to start. */ }
    await delay(100);
  }
  throw new Error(`Production-mode edge did not become ready: ${readLogs()}`);
}

test('production edge validates staff identity and enforces cashier, kitchen, viewer and manager permissions', { timeout: 30000 }, async t => {
  const mockPort = await availablePort();
  const mock = createHttpServer((request, response) => {
    response.setHeader('access-control-allow-origin', '*');
    const token = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
    response.setHeader('content-type', 'application/json');
    if (request.url === '/auth/v1/user') {
      if (token === 'invalid') { response.writeHead(401); response.end(JSON.stringify({ message: 'invalid token' })); return; }
      const role = token.split(':')[0];
      response.end(JSON.stringify({ id: `user-${role}`, email: `${role}@example.test`, user_metadata: { display_name: role } }));
      return;
    }
    if (request.url?.startsWith('/rest/v1/tenant_memberships')) { response.end('[]'); return; }
    if (request.url?.startsWith('/rest/v1/outlet_memberships')) {
      const role = token.split(':')[0];
      if (role === 'no-outlet') { response.end('[]'); return; }
      response.end(JSON.stringify([{ role, status: 'active' }]));
      return;
    }
    response.writeHead(404); response.end(JSON.stringify({ message: 'not found' }));
  });
  await new Promise((resolve, reject) => { mock.once('error', reject); mock.listen(mockPort, '127.0.0.1', resolve); });

  const directory = await mkdtemp(join(tmpdir(), 'common-table-staff-auth-'));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let output = '';
  const child = spawn(process.execPath, ['apps/server/dist/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'production', PORT: String(port), POS_DATABASE_PATH: join(directory, 'edge.sqlite'),
      POS_TENANT_ID: 'auth-test-tenant', POS_TENANT_NAME: 'Auth Test Cafe', POS_OUTLET_ID: 'auth-test-outlet',
      POS_OUTLET_NAME: 'Auth Test Outlet', POS_TERMINAL_ID: 'auth-test-terminal', POS_TERMINAL_NAME: 'Counter 1',
      POS_LOCATION_LABEL: 'Test outlet', POS_ACTOR_ID: 'test-actor',
      POS_TAX_RATE_BPS: '500', POS_CURRENCY: 'INR', POS_TIMEZONE: 'Asia/Kolkata', POS_SESSION_SECRET: secret,
      POS_COOKIE_SECURE: 'false', VITE_SUPABASE_URL: `http://127.0.0.1:${mockPort}`,
      VITE_SUPABASE_PUBLISHABLE_KEY: 'test-publishable-key', POS_SYNC_URL: '', POS_SYNC_TERMINAL_KEY: '',
      MOCK_PRINTER_HOST: '127.0.0.1', MOCK_PRINTER_PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-5000); });
  child.stderr.on('data', chunk => { output = (output + chunk.toString()).slice(-5000); });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(2500)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    await rm(directory, { recursive: true, force: true });
    await new Promise(resolve => mock.close(resolve));
  });

  await waitForReady(baseUrl, child, () => output);

  async function authenticate(role) {
    const response = await fetch(`${baseUrl}/api/auth/session`, {
      method: 'POST', headers: { authorization: `Bearer ${role}:token` },
    });
    const body = await response.json();
    return { response, body, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }

  const invalid = await fetch(`${baseUrl}/api/auth/session`, { method: 'POST', headers: { authorization: 'Bearer invalid' } });
  assert.equal(invalid.status, 401);
  const noOutlet = await fetch(`${baseUrl}/api/auth/session`, { method: 'POST', headers: { authorization: 'Bearer no-outlet:token' } });
  assert.equal(noOutlet.status, 403);
  const absent = await fetch(`${baseUrl}/api/orders`);
  assert.equal(absent.status, 401);

  const cashier = await authenticate('cashier');
  assert.equal(cashier.response.status, 200);
  assert.equal(cashier.body.role, 'cashier');
  assert.match(cashier.response.headers.get('set-cookie') ?? '', /HttpOnly/);
  const nearExpiry = { ...cashier.body, expiresAt: Math.floor(Date.now() / 1000) + 60 };
  const encodedSession = Buffer.from(JSON.stringify(nearExpiry)).toString('base64url');
  const signedSession = createHmac('sha256', secret).update(encodedSession).digest('base64url');
  const nearExpiryCookie = `ct_pos_session=${encodedSession}.${signedSession}`;
  const renewedResponse = await fetch(`${baseUrl}/api/orders`, { headers: { cookie: nearExpiryCookie } });
  assert.equal(renewedResponse.status, 200, 'the local edge accepts the verified session without checking Supabase again');
  const renewedCookie = renewedResponse.headers.get('set-cookie');
  assert.match(renewedCookie ?? '', /Max-Age=2592000/, 'active local use renews the persistent cookie for 30 days');
  const renewedPayload = JSON.parse(Buffer.from(renewedCookie.split('=')[1].split('.')[0], 'base64url').toString());
  assert.ok(renewedPayload.expiresAt > Math.floor(Date.now() / 1000) + 29 * 24 * 60 * 60,
    'offline session renewal extends its signed local expiry');
  assert.equal((await fetch(`${baseUrl}/api/support/diagnostics.json`, { headers: { cookie: cashier.cookie } })).status, 403);
  const cashierKitchen = await fetch(`${baseUrl}/api/kitchen`, { headers: { cookie: cashier.cookie } });
  assert.equal(cashierKitchen.status, 403);
  const cashierVoid = await fetch(`${baseUrl}/api/orders/missing/void`, {
    method: 'POST', headers: { cookie: cashier.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: 'cashier-void-command', reason: 'test reason' }),
  });
  assert.equal(cashierVoid.status, 403);
  const cashierRefund = await fetch(`${baseUrl}/api/orders/missing/refunds`, {
    method: 'POST', headers: { cookie: cashier.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: 'cashier-refund-command', paymentId: 'p', shiftId: 's', amountMinor: 1, reason: 'test' }),
  });
  assert.equal(cashierRefund.status, 403);

  const kitchen = await authenticate('kitchen');
  assert.equal(kitchen.response.status, 200);
  assert.equal((await fetch(`${baseUrl}/api/kitchen`, { headers: { cookie: kitchen.cookie } })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/orders`, { headers: { cookie: kitchen.cookie } })).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/support/diagnostics.json`, { headers: { cookie: kitchen.cookie } })).status, 403);

  const viewer = await authenticate('viewer');
  assert.equal(viewer.response.status, 200);
  assert.equal((await fetch(`${baseUrl}/api/reports/daily`, { headers: { cookie: viewer.cookie } })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/orders`, { headers: { cookie: viewer.cookie } })).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/support/diagnostics.json`, { headers: { cookie: viewer.cookie } })).status, 403);

  const manager = await authenticate('manager');
  assert.equal(manager.response.status, 200);
  const diagnosticsResponse = await fetch(`${baseUrl}/api/support/diagnostics.json`, { headers: { cookie: manager.cookie } });
  assert.equal(diagnosticsResponse.status, 200);
  assert.match(diagnosticsResponse.headers.get('content-disposition') ?? '', /common-table-edge-diagnostics\.json/);
  const diagnostics = await diagnosticsResponse.json();
  assert.equal(diagnostics.database.integrity, 'ok');
  assert.equal(diagnostics.database.foreignKeyViolations, 0);
  assert.equal(diagnostics.database.availableMenuItems, 0, 'the isolated auth test outlet starts with an empty menu');
  assert.equal(diagnostics.outlet.outletId, 'auth-test-outlet');
  assert.equal(diagnostics.process.node, process.version);
  assert.equal(JSON.stringify(diagnostics).includes('test-publishable-key'), false, 'support diagnostics never export auth credentials');
  assert.equal((await fetch(`${baseUrl}/api/orders/missing/void`, {
    method: 'POST', headers: { cookie: manager.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: 'manager-void-command', reason: 'test reason' }),
  })).status, 404, 'manager authorization passed and handler rejected only the missing test order');
  assert.equal((await fetch(`${baseUrl}/api/orders/missing/refunds`, {
    method: 'POST', headers: { cookie: manager.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: 'manager-refund-command', paymentId: 'p', shiftId: 's', amountMinor: 1, reason: 'test' }),
  })).status, 404);

  const signatureStart = manager.cookie.indexOf('.') + 1;
  assert.ok(signatureStart > 0, 'the signed session cookie has a payload and signature');
  const tamperedSignatureChar = manager.cookie[signatureStart] === 'a' ? 'b' : 'a';
  const tamperedCookie = `${manager.cookie.slice(0, signatureStart)}${tamperedSignatureChar}${manager.cookie.slice(signatureStart + 1)}`;
  assert.equal((await fetch(`${baseUrl}/api/orders`, { headers: { cookie: tamperedCookie } })).status, 401);
});
