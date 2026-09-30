'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PgReservationLifecycleService } = require('../src/reservation.lifecycle.pg');

function scripted(responses) {
  const calls = [];
  let i = 0;
  const client = {
    query: async (sql, args = []) => {
      calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), args });
      const response = responses[i++];
      if (response instanceof Error) throw response;
      return response || { rowCount: 0, rows: [] };
    },
    release: () => calls.push({ sql: 'RELEASE', args: [] }),
  };
  return { pool: { connect: async () => client }, calls };
}

test('valid payment converts reserved stock to sold and persists result before commit', async () => {
  const s = scripted([
    {},
    { rowCount: 1, rows: [{ id: 'pe1' }] },
    { rows: [{ id: 'r1', live_session_id: 's', inventory_variant_id: 'sku', quantity: 2, status: 'active', expires_at: '2099-01-01T00:00:00Z' }] },
    { rows: [{ id: 'sku' }] },
    { rowCount: 1 },
    {},
    {},
    {},
  ]);
  const svc = new PgReservationLifecycleService({ pool: s.pool, clock: () => new Date('2026-01-01') });
  const out = await svc.settlePayment({
    merchantId: 'm', reservationId: 'r1', provider: 'paystack',
    providerTransactionId: 'tx1', amountMinor: 5000, currency: 'GHS',
  });
  assert.equal(out.outcome, 'paid');
  const inventoryIndex = s.calls.findIndex((x) => /sold_qty=sold_qty\+\$1/.test(x.sql));
  const reservationIndex = s.calls.findIndex((x) => /SET status='paid'/.test(x.sql));
  assert.ok(inventoryIndex > 0 && inventoryIndex < reservationIndex);
});

test('payment retry is payload-bound, not transaction-id-only', async () => {
  const s = scripted([
    {},
    { rowCount: 0, rows: [] },
    { rows: [{ reservation_id: 'r1', amount_minor: '5000', currency: 'GHS', status: 'processed', result_body: { outcome: 'paid', reservationId: 'r1' } }] },
    {},
  ]);
  const svc = new PgReservationLifecycleService({ pool: s.pool });
  const out = await svc.settlePayment({
    merchantId: 'm', reservationId: 'r1', provider: 'paystack',
    providerTransactionId: 'tx1', amountMinor: 5000, currency: 'GHS',
  });
  assert.equal(out.outcome, 'paid');
});

test('reusing provider transaction id with changed amount is rejected', async () => {
  const s = scripted([
    {},
    { rowCount: 0, rows: [] },
    { rows: [{ reservation_id: 'r1', amount_minor: '5000', currency: 'GHS', status: 'processed', result_body: { outcome: 'paid' } }] },
    {},
  ]);
  const svc = new PgReservationLifecycleService({ pool: s.pool });
  await assert.rejects(
    () => svc.settlePayment({
      merchantId: 'm', reservationId: 'r1', provider: 'paystack',
      providerTransactionId: 'tx1', amountMinor: 7000, currency: 'GHS',
    }),
    (e) => e.code === 'PAYMENT_EVENT_REUSED_WITH_DIFFERENT_PAYLOAD'
  );
});

test('late payment after TTL releases hold and queues waitlist work before COMMIT', async () => {
  const s = scripted([
    {},
    { rowCount: 1, rows: [{ id: 'pe1' }] },
    { rows: [{ id: 'r1', live_session_id: 's', inventory_variant_id: 'sku', quantity: 1, status: 'active', expires_at: '2025-01-01T00:00:00Z' }] },
    { rows: [{ id: 'sku' }] },
    { rowCount: 1 },
    {},
    { rowCount: 1, rows: [{ id: 'job1' }] },
    {},
    {},
  ]);
  const svc = new PgReservationLifecycleService({ pool: s.pool, clock: () => new Date('2026-01-01') });
  const out = await svc.settlePayment({
    merchantId: 'm', reservationId: 'r1', provider: 'paystack',
    providerTransactionId: 'tx-late', amountMinor: 5000, currency: 'GHS',
  });
  assert.equal(out.outcome, 'reconciliation_required');
  assert.equal(out.inventoryReleased, true);
  assert.equal(out.promotionQueued, true);
  const enqueue = s.calls.findIndex((x) => /INSERT INTO lifecycle_outbox/.test(x.sql));
  const commit = s.calls.findIndex((x) => x.sql === 'COMMIT');
  assert.ok(enqueue > 0 && enqueue < commit);
});

test('payment after already-expired reservation enters reconciliation without touching inventory', async () => {
  const s = scripted([
    {},
    { rowCount: 1, rows: [{ id: 'pe1' }] },
    { rows: [{ id: 'r1', live_session_id: 's', inventory_variant_id: 'sku', quantity: 1, status: 'expired', expires_at: '2025-01-01T00:00:00Z' }] },
    {},
    {},
    {},
  ]);
  const svc = new PgReservationLifecycleService({ pool: s.pool });
  const out = await svc.settlePayment({
    merchantId: 'm', reservationId: 'r1', provider: 'paystack',
    providerTransactionId: 'tx-after-expire', amountMinor: 5000, currency: 'GHS',
  });
  assert.equal(out.outcome, 'reconciliation_required');
  assert.equal(out.inventoryReleased, false);
  assert.equal(s.calls.some((x) => /UPDATE inventory_variants/.test(x.sql)), false);
});

test('expiry and cancellation both release stock through the durable outbox boundary', async () => {
  for (const [method, expected] of [['expireReservation', 'expired'], ['cancelReservation', 'cancelled']]) {
    const s = scripted([
      {},
      { rows: [{ id: 'r1', live_session_id: 's', inventory_variant_id: 'sku', quantity: 2, status: 'active', expires_at: '2025-01-01T00:00:00Z' }] },
      { rows: [{ id: 'sku' }] },
      { rowCount: 1 },
      {},
      { rowCount: 1, rows: [{ id: 'job1' }] },
      {},
    ]);
    const svc = new PgReservationLifecycleService({ pool: s.pool, clock: () => new Date('2026-01-01') });
    const out = await svc[method]({ merchantId: 'm', reservationId: 'r1' });
    assert.equal(out.outcome, expected);
    assert.equal(out.promotionQueued, true);
    assert.ok(s.calls.some((x) => /INSERT INTO lifecycle_outbox/.test(x.sql)));
  }
});
