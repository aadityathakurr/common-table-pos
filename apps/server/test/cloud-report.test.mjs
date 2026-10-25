import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aggregateCloudDailyReport } from '../../../supabase/functions/pos-reports/_shared/cloud-report.mjs';

const reportInput = {
  date: '2026-10-25', timeZone: 'Asia/Kolkata', outletName: 'Test Cafe', currency: 'INR',
  startAt: '2026-10-24T18:30:00.000Z', endAt: '2026-10-25T18:30:00.000Z',
};

test('cloud report aggregates split tender, proportional refund tax, voids, and shift close events', () => {
  const order = { id: 'order-1', orderNumber: 'J-ORD-000001', status: 'paid', subtotalMinor: 550, taxTotalMinor: 28, totalMinor: 578,
    lines: [
      { id: 'line-1', menuItemId: 'poha', name: 'Indori Poha', quantity: 1, lineTotalMinor: 550 },
      { id: 'line-2', menuItemId: 'chai', name: 'Masala Chai', quantity: 1, lineTotalMinor: 200, voidedAt: '2026-10-25T01:00:00.000Z' },
    ] };
  const event = (entityType, entityId, action, occurredAt, payload) => ({ entity_type: entityType, entity_id: entityId, action, occurred_at: occurredAt, payload });
  const events = [
    event('order', 'order-1', 'order.created', '2026-10-25T00:00:00.000Z', { ...order, lines: order.lines.map(line => ({ ...line, voidedAt: undefined })) }),
    event('order', 'order-1', 'order.line_voided', '2026-10-25T01:00:00.000Z', order),
    event('payment', 'payment-1', 'payment.recorded', '2026-10-25T02:00:00.000Z', { orderId: 'order-1', method: 'cash', amountMinor: 300 }),
    event('payment', 'payment-2', 'payment.recorded', '2026-10-25T02:00:01.000Z', { orderId: 'order-1', method: 'upi', amountMinor: 278 }),
    event('payment', 'refund-1', 'payment.refunded', '2026-10-25T03:00:00.000Z', { orderId: 'order-1', method: 'upi', amountMinor: 100 }),
    event('shift', 'shift-1', 'shift.closed', '2026-10-25T04:00:00.000Z', { expectedCashMinor: 50000, countedCashMinor: 49995, varianceMinor: -5 }),
  ];
  const report = aggregateCloudDailyReport({ ...reportInput, events });
  assert.equal(report.totals.paidOrderCount, 1);
  assert.equal(report.totals.subtotalMinor, 455);
  assert.equal(report.totals.taxTotalMinor, 23);
  assert.equal(report.totals.salesMinor, 478);
  assert.deepEqual(report.refunds, { count: 1, amountMinor: 100 });
  assert.deepEqual(report.tenders, [
    { method: 'cash', amountMinor: 300, paymentCount: 1 },
    { method: 'upi', amountMinor: 178, paymentCount: 1 },
  ]);
  assert.deepEqual(report.items, [{ menuItemId: 'poha', name: 'Indori Poha', quantity: 1, salesMinor: 550 }]);
  assert.deepEqual(report.voids, { lineCount: 1, quantity: 1, amountMinor: 200 });
  assert.deepEqual(report.shifts, { closedCount: 1, expectedCashMinor: 50000, countedCashMinor: 49995, varianceMinor: -5 });
});

test('cloud report uses the latest available order snapshot for a later-day refund', () => {
  const oldOrder = { id: 'order-old', status: 'paid', subtotalMinor: 200, taxTotalMinor: 10, totalMinor: 210,
    lines: [{ id: 'line-old', menuItemId: 'tea', name: 'Tea', quantity: 1, lineTotalMinor: 200 }] };
  const report = aggregateCloudDailyReport({
    ...reportInput,
    events: [{ entity_type: 'payment', entity_id: 'refund-old', action: 'payment.refunded', occurred_at: '2026-10-25T03:00:00.000Z',
      payload: { orderId: 'order-old', method: 'upi', amountMinor: 105 } }],
    orderHistory: [{ entity_type: 'order', entity_id: 'order-old', action: 'order.created', occurred_at: '2026-10-24T03:00:00.000Z', payload: oldOrder }],
  });
  assert.equal(report.totals.paidOrderCount, 0);
  assert.equal(report.totals.salesMinor, -105);
  assert.equal(report.totals.taxTotalMinor, -5);
  assert.equal(report.totals.subtotalMinor, -100);
  assert.deepEqual(report.tenders, [{ method: 'upi', amountMinor: -105, paymentCount: 0 }]);
});
