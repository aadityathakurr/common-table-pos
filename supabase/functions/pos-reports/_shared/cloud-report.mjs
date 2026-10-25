function amount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function snapshotFor(event) {
  const payload = event?.payload;
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    && typeof payload.id === 'string' && Array.isArray(payload.lines)
    ? payload
    : null;
}

export function aggregateCloudDailyReport({ date, timeZone, outletName, currency, startAt, endAt, events, orderHistory = [] }) {
  const latestSnapshots = new Map();
  for (const event of [...events, ...orderHistory]) {
    if (event.entity_type !== 'order') continue;
    const snapshot = snapshotFor(event);
    if (!snapshot) continue;
    const previous = latestSnapshots.get(event.entity_id);
    if (!previous || Date.parse(event.occurred_at) > Date.parse(previous.occurred_at)) {
      latestSnapshots.set(event.entity_id, { occurred_at: event.occurred_at, order: snapshot });
    }
  }

  const tenders = new Map();
  const paidOrderIds = new Set();
  const refundAmounts = new Map();
  let refundCount = 0;
  let refundAmountMinor = 0;
  for (const event of events) {
    if (event.entity_type !== 'payment') continue;
    const payload = event.payload ?? {};
    const method = payload.method;
    const orderId = payload.orderId;
    const value = amount(payload.amountMinor);
    if (!['cash', 'upi', 'card'].includes(method) || typeof orderId !== 'string' || value === 0) continue;
    if (event.action === 'payment.recorded') {
      paidOrderIds.add(orderId);
      const row = tenders.get(method) ?? { method, amountMinor: 0, paymentCount: 0 };
      row.amountMinor += value;
      row.paymentCount += 1;
      tenders.set(method, row);
    } else if (event.action === 'payment.refunded') {
      refundCount += 1;
      refundAmountMinor += value;
      refundAmounts.set(orderId, (refundAmounts.get(orderId) ?? 0) + value);
      const row = tenders.get(method) ?? { method, amountMinor: 0, paymentCount: 0 };
      row.amountMinor -= value;
      tenders.set(method, row);
    }
  }

  let grossSubtotal = 0;
  let grossTax = 0;
  let grossSales = 0;
  const itemsById = new Map();
  for (const orderId of paidOrderIds) {
    const order = latestSnapshots.get(orderId)?.order;
    if (!order) continue;
    grossSubtotal += amount(order.subtotalMinor);
    grossTax += amount(order.taxTotalMinor);
    grossSales += amount(order.totalMinor);
    for (const line of order.lines) {
      if (!line || line.voidedAt || typeof line.name !== 'string') continue;
      const key = `${line.menuItemId ?? ''}\u0000${line.name}`;
      const item = itemsById.get(key) ?? { menuItemId: line.menuItemId ?? '', name: line.name, quantity: 0, salesMinor: 0 };
      item.quantity += amount(line.quantity);
      item.salesMinor += amount(line.lineTotalMinor);
      itemsById.set(key, item);
    }
  }

  let refundTaxMinor = 0;
  for (const [orderId, refunded] of refundAmounts) {
    const order = latestSnapshots.get(orderId)?.order;
    if (order && amount(order.totalMinor) > 0) {
      refundTaxMinor += Math.round(amount(order.taxTotalMinor) * refunded / amount(order.totalMinor));
    }
  }

  const voidedLines = new Map();
  for (const [orderId, snapshot] of latestSnapshots) {
    for (const line of snapshot.order.lines) {
      if (!line?.voidedAt || typeof line.id !== 'string') continue;
      voidedLines.set(line.id, line);
    }
  }
  let voidQuantity = 0;
  let voidAmountMinor = 0;
  for (const line of voidedLines.values()) {
    voidQuantity += amount(line.quantity);
    voidAmountMinor += amount(line.lineTotalMinor);
  }

  let closedCount = 0;
  let expectedCashMinor = 0;
  let countedCashMinor = 0;
  let varianceMinor = 0;
  for (const event of events) {
    if (event.entity_type !== 'shift' || event.action !== 'shift.closed') continue;
    const payload = event.payload ?? {};
    closedCount += 1;
    expectedCashMinor += amount(payload.expectedCashMinor);
    countedCashMinor += amount(payload.countedCashMinor);
    varianceMinor += Number.isSafeInteger(payload.varianceMinor) ? payload.varianceMinor : 0;
  }

  return {
    date, timeZone, outletName, currency, startAt, endAt, generatedAt: new Date().toISOString(),
    totals: {
      paidOrderCount: paidOrderIds.size,
      subtotalMinor: grossSubtotal - (refundAmountMinor - refundTaxMinor),
      taxTotalMinor: grossTax - refundTaxMinor,
      salesMinor: grossSales - refundAmountMinor,
    },
    refunds: { count: refundCount, amountMinor: refundAmountMinor },
    tenders: [...tenders.values()].sort((a, b) => a.method.localeCompare(b.method)),
    items: [...itemsById.values()].sort((a, b) => b.salesMinor - a.salesMinor || a.name.localeCompare(b.name)),
    voids: { lineCount: voidedLines.size, quantity: voidQuantity, amountMinor: voidAmountMinor },
    shifts: { closedCount, expectedCashMinor, countedCashMinor, varianceMinor },
  };
}
