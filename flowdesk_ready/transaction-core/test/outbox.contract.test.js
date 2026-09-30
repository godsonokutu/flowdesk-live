'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PgLifecycleOutboxWorker,
  enqueueInventoryAvailable,
  isRetryableError,
} = require('../src/lifecycle.outbox.pg');

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
  return { pool: { connect: async () => client }, client, calls };
}

const job = {
  id: 'job1', merchant_id: 'm', event_type: 'inventory_available',
  source_type: 'reservation_expiry', source_id: 'r-old',
  live_session_id: 's1', inventory_variant_id: 'sku1',
  dedupe_key: 'd1', payload: {}, attempts: 0,
};

test('outbox enqueue requires immutable source identity before DB access', async () => {
  let called = false;
  const client = { query: async () => { called = true; } };
  await assert.rejects(
    () => enqueueInventoryAvailable(client, {
      merchantId: 'm', sessionId: 's', inventoryVariantId: 'sku',
      sourceType: 'inventory_adjustment',
    }),
    (e) => e.code === 'INVALID_OUTBOX_INPUT'
  );
  assert.equal(called, false);
});

test('worker job claim uses PostgreSQL-valid LIMIT then FOR UPDATE SKIP LOCKED ordering', async () => {
  const s = scripted([{}, { rows: [] }, {}]);
  const worker = new PgLifecycleOutboxWorker({ pool: s.pool });
  const out = await worker.processNext();
  assert.equal(out.outcome, 'idle');
  const claim = s.calls.find((x) => /FROM lifecycle_outbox/.test(x.sql));
  assert.match(claim.sql, /ORDER BY .* LIMIT 1 FOR UPDATE SKIP LOCKED/);
});

test('worker promotes strict FIFO quantities without buyer-level SKIP LOCKED', async () => {
  const s = scripted([
    {}, { rows: [job] }, {}, {},
    { rows: [{ id: 's1', status: 'live', reservation_ttl_seconds: 300 }] },
    { rows: [{ id: 'sku1', available_qty: 3, reserved_qty: 0 }] },
    { rows: [{ id: 'w1', buyer_id: 'b1', quantity: 2, position_seq: '1' }] },
    { rows: [{ id: 'r-new1', expires_at: '2026-01-01T00:05:00Z', quantity: 2 }] },
    { rowCount: 1 }, { rowCount: 1 }, {},
    { rows: [{ id: 'w2', buyer_id: 'b2', quantity: 1, position_seq: '2' }] },
    { rows: [{ id: 'r-new2', expires_at: '2026-01-01T00:05:00Z', quantity: 1 }] },
    { rowCount: 1 }, { rowCount: 1 }, {},
    {}, {},
  ]);
  const worker = new PgLifecycleOutboxWorker({ pool: s.pool, random: () => 0.5 });
  const out = await worker.processNext();
  assert.equal(out.outcome, 'completed');
  assert.deepEqual(out.result.promotions.map((x) => x.quantity), [2, 1]);
  const selects = s.calls.filter((x) => /FROM waitlist_entries/.test(x.sql));
  assert.ok(selects.length >= 2);
  for (const q of selects) {
    assert.match(q.sql, /ORDER BY position_seq ASC LIMIT 1 FOR UPDATE/);
    assert.doesNotMatch(q.sql, /SKIP LOCKED/);
  }
});

test('strict FIFO blocks a later smaller buyer if head quantity does not fit', async () => {
  const s = scripted([
    {}, { rows: [job] }, {}, {},
    { rows: [{ id: 's1', status: 'live', reservation_ttl_seconds: 300 }] },
    { rows: [{ id: 'sku1', available_qty: 1, reserved_qty: 0 }] },
    { rows: [{ id: 'w1', buyer_id: 'b1', quantity: 2, position_seq: '1' }] },
    {}, {},
  ]);
  const worker = new PgLifecycleOutboxWorker({ pool: s.pool });
  const out = await worker.processNext();
  assert.equal(out.result.outcome, 'head_waiting_for_more_stock');
  assert.equal(s.calls.some((x) => /INSERT INTO reservations/.test(x.sql)), false);
});

test('retryable SQL failure rolls back handler savepoint and schedules bounded retry', async () => {
  const error = new Error('deadlock');
  error.code = '40P01';
  const s = scripted([
    {}, { rows: [job] }, {}, {},
    { rows: [{ id: 's1', status: 'live', reservation_ttl_seconds: 300 }] },
    error,
    {}, {}, {},
  ]);
  const worker = new PgLifecycleOutboxWorker({
    pool: s.pool, baseRetryMs: 1000, maxRetryMs: 10000, random: () => 0.5,
  });
  const out = await worker.processNext();
  assert.equal(out.outcome, 'retry_scheduled');
  assert.equal(out.delayMs, 1000);
  assert.ok(s.calls.some((x) => x.sql === 'ROLLBACK TO SAVEPOINT lifecycle_handler'));
});

test('retry classifier excludes uniqueness/domain conflicts from transient retry loop', () => {
  const deadlock = new Error('deadlock'); deadlock.code = '40P01';
  const unique = new Error('unique'); unique.code = '23505';
  assert.equal(isRetryableError(deadlock), true);
  assert.equal(isRetryableError(unique), false);
});
