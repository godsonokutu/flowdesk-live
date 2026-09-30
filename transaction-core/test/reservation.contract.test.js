'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PgReservationService,
  DomainError,
  stableHash,
} = require('../src/reservation.pg');

function scripted(responses) {
  const calls = [];
  let i = 0;
  const client = {
    query: async (sql, args = []) => {
      calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), args });
      const response = responses[i++];
      if (response instanceof Error) throw response;
      if (typeof response === 'function') return response({ sql, args, calls, index: i - 1 });
      return response || { rowCount: 0, rows: [] };
    },
    release: () => calls.push({ sql: 'RELEASE', args: [] }),
  };
  return { pool: { connect: async () => client }, calls };
}

test('stableHash is recursively canonical and deterministic', () => {
  assert.equal(
    stableHash({ z: [3, { b: 2, a: 1 }], a: { y: 2, x: 1 } }),
    stableHash({ a: { x: 1, y: 2 }, z: [3, { a: 1, b: 2 }] })
  );
});

test('rejects malformed quantity before DB access', async () => {
  let connected = false;
  const svc = new PgReservationService({ pool: { connect: async () => { connected = true; } } });
  await assert.rejects(
    () => svc.acceptBuyerIntent({
      merchantId: 'm', sessionId: 's', inventoryVariantId: 'i', buyerId: 'b',
      quantity: 0, idempotencyKey: '0123456789abcdef',
    }),
    (e) => e instanceof DomainError && e.code === 'INVALID_QUANTITY'
  );
  assert.equal(connected, false);
});

test('waitlist preserves requested quantity and does not lock aggregate output', async () => {
  const s = scripted([
    {}, // BEGIN
    { rowCount: 1, rows: [{}] }, // idempotency insert
    { rows: [{ id: 's', status: 'live', reservation_ttl_seconds: 300 }] },
    { rows: [{ id: 'sku', available_qty: 0, reserved_qty: 0, version: '7' }] },
    { rows: [{ next_position: '4' }] },
    { rows: [{ id: 'w4', status: 'waiting', position_seq: '4', quantity: 3 }] },
    {}, // idempotency response
    {}, // COMMIT
  ]);
  const svc = new PgReservationService({ pool: s.pool });
  const out = await svc.acceptBuyerIntent({
    merchantId: 'm', sessionId: 's', inventoryVariantId: 'sku', buyerId: 'b',
    quantity: 3, idempotencyKey: '0123456789abcdef',
  });
  assert.equal(out.outcome, 'waitlisted');
  assert.equal(out.waitlist.quantity, 3);
  const aggregate = s.calls.find((x) => /MAX\(position_seq\)/.test(x.sql));
  assert.ok(aggregate);
  assert.doesNotMatch(aggregate.sql, /FOR UPDATE/);
  const insert = s.calls.find((x) => /INSERT INTO waitlist_entries/.test(x.sql));
  assert.equal(insert.args[4], 3);
});

test('duplicate provider delivery returns original durable reservation instead of creating another', async () => {
  const s = scripted([
    {},
    { rowCount: 1, rows: [{}] },
    { rowCount: 0, rows: [] },
    { rows: [{ payload_hash: stableHash({ sessionId: 's', inventoryVariantId: 'sku', buyerId: 'b', quantity: 2, providerEventId: 'wamid-1' }) }] },
    { rows: [{ id: 'r1', status: 'active', expires_at: '2099-01-01T00:00:00Z', quantity: 2 }] },
    {},
    {},
  ]);
  const svc = new PgReservationService({ pool: s.pool });
  const out = await svc.acceptBuyerIntent({
    merchantId: 'm', sessionId: 's', inventoryVariantId: 'sku', buyerId: 'b',
    quantity: 2, idempotencyKey: 'fedcba9876543210', providerEventId: 'wamid-1',
  });
  assert.equal(out.outcome, 'reserved');
  assert.equal(out.deduplicated, true);
  assert.equal(out.reservation.id, 'r1');
  assert.equal(s.calls.some((x) => /FROM inventory_variants/.test(x.sql)), false);
});

test('guarded inventory claim rolls back when accounting predicate updates zero rows', async () => {
  const s = scripted([
    {},
    { rowCount: 1, rows: [{}] },
    { rows: [{ id: 's', status: 'live', reservation_ttl_seconds: 300 }] },
    { rows: [{ id: 'sku', available_qty: 1, reserved_qty: 0, version: '0' }] },
    { rows: [{ id: 'r1', status: 'active', expires_at: '2099-01-01T00:00:00Z', quantity: 1 }] },
    { rowCount: 0, rows: [] },
    {},
  ]);
  const svc = new PgReservationService({ pool: s.pool });
  await assert.rejects(
    () => svc.acceptBuyerIntent({
      merchantId: 'm', sessionId: 's', inventoryVariantId: 'sku', buyerId: 'b',
      quantity: 1, idempotencyKey: '0011223344556677',
    }),
    (e) => e.code === 'INVENTORY_ACCOUNTING_CONFLICT'
  );
  assert.ok(s.calls.some((x) => x.sql === 'ROLLBACK'));
});

test('provider event id cannot be replayed with a changed buyer intent payload', async () => {
  const s = scripted([
    {},
    { rowCount: 1, rows: [{}] },
    { rowCount: 0, rows: [] },
    { rows: [{ payload_hash: 'different-hash' }] },
    {},
  ]);
  const svc = new PgReservationService({ pool: s.pool });
  await assert.rejects(
    () => svc.acceptBuyerIntent({
      merchantId: 'm', sessionId: 's', inventoryVariantId: 'sku', buyerId: 'b',
      quantity: 2, idempotencyKey: 'abcdef0123456789', providerEventId: 'wamid-1',
    }),
    (e) => e.code === 'PROVIDER_EVENT_REUSED_WITH_DIFFERENT_PAYLOAD'
  );
});
