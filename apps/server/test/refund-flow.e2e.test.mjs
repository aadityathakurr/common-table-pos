import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

const root = process.cwd();
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

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
    if (child.exitCode !== null) throw new Error(`Test edge exited early: ${readLogs()}`);
    try {
      const response = await fetch(`${baseUrl}/api/ready`);
      if (response.ok) return;
    } catch { /* Wait for SQLite and the HTTP listener to start. */ }
    await delay(100);
  }
  throw new Error(`Test edge did not become ready: ${readLogs()}`);
}

async function jsonRequest(baseUrl, path, options) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { ...(options?.body ? { 'content-type': 'application/json' } : {}), ...options?.headers },
  });
  const body = response.status === 204 ? null : await response.json();
  return { response, body };
}

test('edge order payment refund and shift reports stay idempotent and reconcile net cash', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'common-table-refund-'));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let output = '';
  const child = spawn(process.execPath, ['apps/server/dist/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'development', PORT: String(port), POS_DATABASE_PATH: join(directory, 'edge.sqlite'),
      POS_TENANT_ID: 'refund-test-tenant', POS_TENANT_NAME: 'Refund Test Cafe', POS_OUTLET_ID: 'refund-test-outlet',
      POS_OUTLET_NAME: 'Refund Test Outlet', POS_TERMINAL_ID: 'refund-test-terminal', POS_TERMINAL_NAME: 'Counter 1',
      POS_TAX_RATE_BPS: '500', DEMO_TAX_RATE_BPS: '500', POS_CURRENCY: 'INR', POS_TIMEZONE: 'Asia/Kolkata',
      MOCK_PRINTER_HOST: '127.0.0.1', MOCK_PRINTER_PORT: '0', POS_SESSION_SECRET: '',
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
  });

  await waitForReady(baseUrl, child, () => output);
  const { body: context } = await jsonRequest(baseUrl, '/api/context');
  const shiftOpen = await jsonRequest(baseUrl, '/api/shifts/open', {
    method: 'POST', body: JSON.stringify({ commandId: randomUUID(), openingFloatMinor: 50000 }),
  });
  assert.equal(shiftOpen.response.status, 201);
  const shiftId = shiftOpen.body.shift.id;

  const orderResult = await jsonRequest(baseUrl, '/api/orders', {
    method: 'POST', body: JSON.stringify({ commandId: randomUUID(), tenantId: context.tenantId, outletId: context.outletId,
      terminalId: context.terminalId, orderType: 'takeaway', guestCount: 1,
      lines: [{ menuItemId: 'indori-poha', quantity: 1 }] }),
  });
  assert.equal(orderResult.response.status, 201);
  const order = orderResult.body;
  assert.equal(order.taxRateBps, 500);

  const payment = await jsonRequest(baseUrl, `/api/orders/${order.id}/payment`, {
    method: 'POST', body: JSON.stringify({ commandId: randomUUID(), shiftId, method: 'cash', amountMinor: order.totalMinor }),
  });
  assert.equal(payment.response.status, 200);
  assert.equal(payment.body.status, 'paid');

  const paymentList = await jsonRequest(baseUrl, `/api/orders/${order.id}/payments`);
  assert.equal(paymentList.response.status, 200);
  assert.equal(paymentList.body.tenders.length, 1);
  const tender = paymentList.body.tenders[0];
  assert.equal(tender.refundableMinor, order.totalMinor);

  const refundPayload = { commandId: randomUUID(), paymentId: tender.id, shiftId, amountMinor: 500, reason: 'Test refund' };
  const firstRefund = await jsonRequest(baseUrl, `/api/orders/${order.id}/refunds`, {
    method: 'POST', body: JSON.stringify(refundPayload),
  });
  assert.equal(firstRefund.response.status, 201);
  assert.equal(firstRefund.body.refund.amountMinor, 500);
  const replay = await jsonRequest(baseUrl, `/api/orders/${order.id}/refunds`, {
    method: 'POST', body: JSON.stringify(refundPayload),
  });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.refund.id, firstRefund.body.refund.id);

  const changedReplay = await jsonRequest(baseUrl, `/api/orders/${order.id}/refunds`, {
    method: 'POST', body: JSON.stringify({ ...refundPayload, amountMinor: 501 }),
  });
  assert.equal(changedReplay.response.status, 409);
  const overRefund = await jsonRequest(baseUrl, `/api/orders/${order.id}/refunds`, {
    method: 'POST', body: JSON.stringify({ ...refundPayload, commandId: randomUUID(), amountMinor: order.totalMinor }),
  });
  assert.equal(overRefund.response.status, 409);

  const remaining = await jsonRequest(baseUrl, `/api/orders/${order.id}/payments`);
  assert.equal(remaining.body.tenders[0].refundableMinor, order.totalMinor - 500);
  assert.equal(remaining.body.refunds.length, 1);

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const report = await jsonRequest(baseUrl, `/api/reports/daily?date=${today}`);
  assert.equal(report.response.status, 200);
  assert.equal(report.body.totals.salesMinor, order.totalMinor - 500);
  assert.equal(report.body.refunds.amountMinor, 500);
  assert.equal(report.body.tenders.find(row => row.method === 'cash').amountMinor, order.totalMinor - 500);

  const expectedCashMinor = 50000 + order.totalMinor - 500;
  const close = await jsonRequest(baseUrl, `/api/shifts/${shiftId}/close`, {
    method: 'POST', body: JSON.stringify({ commandId: randomUUID(), countedCashMinor: expectedCashMinor }),
  });
  assert.equal(close.response.status, 200);
  assert.equal(close.body.shift.varianceMinor, 0);
});
