import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aggregateCloudDailyReport, aggregateCloudProjectionReport } from '../../../supabase/functions/pos-reports/_shared/cloud-report.mjs';

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

test('cloud projections preserve daily tender, tax, item, void, and shift totals', () => {
  const report = aggregateCloudProjectionReport({
    ...reportInput,
    payments: [
      { order_id: 'order-1', entry_type: 'tender', method: 'cash', amount_minor: '300', status: 'succeeded' },
      { order_id: 'order-1', entry_type: 'tender', method: 'upi', amount_minor: '278', status: 'succeeded' },
      { order_id: 'order-1', entry_type: 'refund', method: 'upi', amount_minor: '100', status: 'succeeded' },
    ],
    orders: [{ order_id: 'order-1', subtotal_minor: '550', tax_total_minor: '28', total_minor: '578' }],
    orderItems: [
      { order_id: 'order-1', line_id: 'line-1', menu_item_id: 'poha', name: 'Indori Poha', quantity: 1, line_total_minor: '550', voided_at: null },
      { order_id: 'order-1', line_id: 'line-2', menu_item_id: 'chai', name: 'Masala Chai', quantity: 1, line_total_minor: '200', voided_at: '2026-10-25T01:00:00.000Z' },
    ],
    voidedItems: [
      { order_id: 'order-1', line_id: 'line-2', quantity: 1, line_total_minor: '200', voided_at: '2026-10-25T01:00:00.000Z' },
      { order_id: 'order-1', line_id: 'old-void', quantity: 2, line_total_minor: '80', voided_at: '2026-10-24T17:00:00.000Z' },
    ],
    shifts: [{ shift_id: 'shift-1', status: 'closed', closed_at: '2026-10-25T04:00:00.000Z',
      expected_cash_minor: '50000', counted_cash_minor: '49995', variance_minor: '-5' }],
  });
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

test('cloud projections calculate refunds on a later business day from the stored order snapshot', () => {
  const report = aggregateCloudProjectionReport({
    ...reportInput,
    payments: [{ order_id: 'order-old', entry_type: 'refund', method: 'upi', amount_minor: '105', status: 'succeeded' }],
    orders: [{ order_id: 'order-old', subtotal_minor: '200', tax_total_minor: '10', total_minor: '210' }],
    orderItems: [], voidedItems: [], shifts: [],
  });
  assert.equal(report.totals.paidOrderCount, 0);
  assert.equal(report.totals.salesMinor, -105);
  assert.equal(report.totals.taxTotalMinor, -5);
  assert.equal(report.totals.subtotalMinor, -100);
  assert.deepEqual(report.tenders, [{ method: 'upi', amountMinor: -105, paymentCount: 0 }]);
});

test('cloud tax breakdown keeps item rates separate, including explicit zero, and allocates refund tax', () => {
  const report = aggregateCloudProjectionReport({
    ...reportInput,
    payments: [
      { order_id: 'mixed-tax', entry_type: 'tender', method: 'upi', amount_minor: '2050', status: 'succeeded' },
      { order_id: 'mixed-tax', entry_type: 'refund', method: 'upi', amount_minor: '205', status: 'succeeded' },
    ],
    orders: [{ order_id: 'mixed-tax', subtotal_minor: '2000', tax_total_minor: '50', total_minor: '2050' }],
    orderItems: [
      { order_id: 'mixed-tax', line_id: 'taxed', menu_item_id: 'a', name: 'Taxed item', quantity: 1, line_total_minor: '1000', tax_code: '1101', tax_rate_bps: 500, voided_at: null },
      { order_id: 'mixed-tax', line_id: 'zero', menu_item_id: 'b', name: 'Zero rate item', quantity: 1, line_total_minor: '1000', tax_code: null, tax_rate_bps: 0, voided_at: null },
    ],
    voidedItems: [], shifts: [],
  });
  assert.deepEqual(report.taxBreakdown, [
    { taxCode: null, taxRateBps: 0, taxMinor: 0 },
    { taxCode: '1101', taxRateBps: 500, taxMinor: 45 },
  ]);
  assert.equal(report.taxBreakdown.reduce((sum, row) => sum + row.taxMinor, 0), report.totals.taxTotalMinor);
});
