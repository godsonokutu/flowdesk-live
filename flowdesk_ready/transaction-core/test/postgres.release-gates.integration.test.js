'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

if (!process.env.DATABASE_URL) {
  test('PostgreSQL integration release gate requires DATABASE_URL', { skip: true }, () => {});
} else {
  const { Pool } = require('pg');
  const { PgReservationService } = require('../src/reservation.pg');
  const { PgReservationLifecycleService } = require('../src/reservation.lifecycle.pg');
  const { PgLifecycleOutboxWorker } = require('../src/lifecycle.outbox.pg');
  const { PgReservationOverrideService } = require('../src/reservation.override.pg');
  const { PgReservationVariantService } = require('../src/reservation.variant.pg');
  const { PgLiveSessionShutdownService } = require('../src/live-session.shutdown.pg');

  const poolA = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 40,
    application_name: 'flowdesk-integration-a',
  });
  const poolB = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 40,
    application_name: 'flowdesk-integration-b',
  });

  const id = () => crypto.randomUUID();
  const idem = (prefix) => `${prefix}-${crypto.randomUUID()}`;

  test.after(async () => {
    await Promise.all([poolA.end(), poolB.end()]);
  });

  test.beforeEach(async () => {
    await poolA.query(`TRUNCATE TABLE
      audit_events,
      payment_events,
      lifecycle_outbox,
      waitlist_entries,
      reservations,
      provider_events,
      idempotency_requests,
      inventory_variants,
      live_sessions
      CASCADE`);
  });

  async function fixture(stock = 1, ttl = 300) {
    const merchant = id();
    const session = id();
    const sku = id();
    await poolA.query(`INSERT INTO live_sessions
      (id,merchant_id,name,status,reservation_ttl_seconds)
      VALUES ($1,$2,'gate','live',$3)`, [session, merchant, ttl]);
    await poolA.query(`INSERT INTO inventory_variants
      (id,merchant_id,sku,available_qty,reserved_qty,sold_qty)
      VALUES ($1,$2,$3,$4,0,0)`, [sku, merchant, `sku-${sku}`, stock]);
    return { merchant, session, sku };
  }

  async function inventory(sku) {
    return (await poolA.query(`SELECT available_qty,reserved_qty,sold_qty,version
      FROM inventory_variants WHERE id=$1`, [sku])).rows[0];
  }

  test('C01: 50 concurrent buyers against 6 units => exactly 6 reservations and 44 waitlisted', async () => {
    const f = await fixture(6);
    const services = [new PgReservationService({ pool: poolA }), new PgReservationService({ pool: poolB })];
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => services[i % 2].acceptBuyerIntent({
        merchantId: f.merchant,
        sessionId: f.session,
        inventoryVariantId: f.sku,
        buyerId: id(),
        quantity: 1,
        idempotencyKey: idem(`c01-${i}`),
        providerEventId: `wa-${id()}`,
      }))
    );

    assert.equal(results.filter((x) => x.outcome === 'reserved').length, 6);
    assert.equal(results.filter((x) => x.outcome === 'waitlisted').length, 44);
    const inv = await inventory(f.sku);
    assert.equal(inv.available_qty, 0);
    assert.equal(inv.reserved_qty, 6);
    assert.ok(inv.available_qty >= 0);
    const count = await poolA.query(`SELECT
      COUNT(*) FILTER (WHERE status IN ('active','payment_pending'))::int AS reservations,
      (SELECT COUNT(*)::int FROM waitlist_entries WHERE status='waiting') AS waitlisted
      FROM reservations`);
    assert.equal(count.rows[0].reservations, 6);
    assert.equal(count.rows[0].waitlisted, 44);
  });

  test('C02: same WhatsApp event delivered 5 times creates one durable side effect', async () => {
    const f = await fixture(5);
    const services = [new PgReservationService({ pool: poolA }), new PgReservationService({ pool: poolB })];
    const buyer = id();
    const providerEventId = `wamid-${id()}`;
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => services[i % 2].acceptBuyerIntent({
        merchantId: f.merchant,
        sessionId: f.session,
        inventoryVariantId: f.sku,
        buyerId: buyer,
        quantity: 1,
        idempotencyKey: idem(`c02-${i}`),
        providerEventId,
      }))
    );

    assert.ok(results.every((x) => x.outcome === 'reserved'));
    const reservationIds = new Set(results.map((x) => x.reservation.id));
    assert.equal(reservationIds.size, 1);

    const counts = (await poolA.query(`SELECT
      (SELECT COUNT(*)::int FROM provider_events WHERE merchant_id=$1 AND provider_event_id=$2) AS provider_events,
      (SELECT COUNT(*)::int FROM reservations WHERE merchant_id=$1 AND provider_event_id=$2) AS reservations`,
      [f.merchant, providerEventId])).rows[0];
    assert.equal(counts.provider_events, 1);
    assert.equal(counts.reservations, 1);
    const inv = await inventory(f.sku);
    assert.equal(inv.available_qty, 4);
    assert.equal(inv.reserved_qty, 1);
  });

  test('C03: same payment callback delivered 10 times moves stock exactly once', async () => {
    const f = await fixture(1);
    const reserve = new PgReservationService({ pool: poolA });
    const lifecycleA = new PgReservationLifecycleService({ pool: poolA });
    const lifecycleB = new PgReservationLifecycleService({ pool: poolB });

    const r = await reserve.acceptBuyerIntent({
      merchantId: f.merchant, sessionId: f.session, inventoryVariantId: f.sku,
      buyerId: id(), idempotencyKey: idem('c03-reserve'), providerEventId: `wa-${id()}`,
    });
    const tx = `pay-${id()}`;

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => (i % 2 ? lifecycleA : lifecycleB).settlePayment({
        merchantId: f.merchant,
        reservationId: r.reservation.id,
        provider: 'paystack',
        providerTransactionId: tx,
        amountMinor: 15000,
        currency: 'GHS',
      }))
    );

    assert.ok(results.every((x) => ['paid', 'already_paid'].includes(x.outcome)));
    const inv = await inventory(f.sku);
    assert.equal(inv.available_qty, 0);
    assert.equal(inv.reserved_qty, 0);
    assert.equal(inv.sold_qty, 1);
    const events = await poolA.query(`SELECT COUNT(*)::int AS count
      FROM payment_events WHERE merchant_id=$1 AND provider_transaction_id=$2`, [f.merchant, tx]);
    assert.equal(events.rows[0].count, 1);
  });

  test('C04: expiry releases inventory and queues promotion exactly once', async () => {
    const f = await fixture(1);
    const reserve = new PgReservationService({ pool: poolA });
    const lifecycle = new PgReservationLifecycleService({ pool: poolA });

    const r = await reserve.acceptBuyerIntent({
      merchantId: f.merchant, sessionId: f.session, inventoryVariantId: f.sku,
      buyerId: id(), idempotencyKey: idem('c04'), providerEventId: `wa-${id()}`,
    });
    await poolA.query(`UPDATE reservations SET expires_at=now()-interval '1 minute' WHERE id=$1`, [r.reservation.id]);

    const first = await lifecycle.expireReservation({ merchantId: f.merchant, reservationId: r.reservation.id });
    const second = await lifecycle.expireReservation({ merchantId: f.merchant, reservationId: r.reservation.id });

    assert.equal(first.outcome, 'expired');
    assert.equal(second.outcome, 'no_change');
    const inv = await inventory(f.sku);
    assert.equal(inv.available_qty, 1);
    assert.equal(inv.reserved_qty, 0);
    const outbox = await poolA.query(`SELECT COUNT(*)::int AS count FROM lifecycle_outbox
      WHERE merchant_id=$1 AND source_type='reservation_expiry' AND source_id=$2`,
      [f.merchant, r.reservation.id]);
    assert.equal(outbox.rows[0].count, 1);
  });

  test('C05: FIFO promotion preserves requested quantity and gives fresh server TTL', async () => {
    const f = await fixture(0, 300);
    const reserve = new PgReservationService({ pool: poolA });
    const b1 = id(), b2 = id();

    const w1 = await reserve.acceptBuyerIntent({
      merchantId: f.merchant, sessionId: f.session, inventoryVariantId: f.sku,
      buyerId: b1, quantity: 2, idempotencyKey: idem('c05-w1'), providerEventId: `wa-${id()}`,
    });
    const w2 = await reserve.acceptBuyerIntent({
      merchantId: f.merchant, sessionId: f.session, inventoryVariantId: f.sku,
      buyerId: b2, quantity: 1, idempotencyKey: idem('c05-w2'), providerEventId: `wa-${id()}`,
    });
    assert.equal(w1.outcome, 'waitlisted');
    assert.equal(w2.outcome, 'waitlisted');

    const adjustmentId = id();
    await poolA.query('BEGIN');
    await poolA.query(`UPDATE inventory_variants SET available_qty=available_qty+3,version=version+1 WHERE id=$1`, [f.sku]);
    await poolA.query(`INSERT INTO lifecycle_outbox
      (merchant_id,event_type,source_type,source_id,live_session_id,inventory_variant_id,dedupe_key,payload)
      VALUES ($1,'inventory_available','inventory_adjustment',$2,$3,$4,$5,'{}'::jsonb)`,
      [f.merchant, adjustmentId, f.session, f.sku, `inventory_available:inventory_adjustment:${adjustmentId}`]);
    await poolA.query('COMMIT');

    const before = Date.now();
    const worker = new PgLifecycleOutboxWorker({ pool: poolB, random: () => 0.5 });
    const result = await worker.processNext();
    const after = Date.now();

    assert.equal(result.outcome, 'completed');
    assert.deepEqual(result.result.promotions.map((x) => x.quantity), [2, 1]);

    const promoted = await poolA.query(`SELECT buyer_id,quantity,expires_at
      FROM reservations WHERE promotion_outbox_id=$1 ORDER BY created_at,id`, [result.jobId]);
    assert.deepEqual(promoted.rows.map((x) => Number(x.quantity)), [2, 1]);
    assert.equal(promoted.rows[0].buyer_id, b1);
    assert.equal(promoted.rows[1].buyer_id, b2);
    for (const row of promoted.rows) {
      const expiry = new Date(row.expires_at).getTime();
      assert.ok(expiry >= before + 290_000);
      assert.ok(expiry <= after + 310_000);
    }
  });

  test('C06: late payment after stock reallocation enters reconciliation and never steals stock', async () => {
    const f = await fixture(1);
    const reserve = new PgReservationService({ pool: poolA });
    const lifecycle = new PgReservationLifecycleService({ pool: poolA });

    const owner = await reserve.acceptBuyerIntent({
      merchantId: f.merchant, sessionId: f.session, inventoryVariantId: f.sku,
      buyerId: id(), idempotencyKey: idem('c06-owner'), providerEventId: `wa-${id()}`,
    });
    await reserve.acceptBuyerIntent({
      merchantId: f.merchant, sessionId: f.session, inventoryVariantId: f.sku,
      buyerId: id(), idempotencyKey: idem('c06-wait'), providerEventId: `wa-${id()}`,
    });

    await poolA.query(`UPDATE reservations SET expires_at=now()-interval '1 minute' WHERE id=$1`, [owner.reservation.id]);
    await lifecycle.expireReservation({ merchantId: f.merchant, reservationId: owner.reservation.id });

    const worker = new PgLifecycleOutboxWorker({ pool: poolB });
    const promotion = await worker.processNext();
    assert.equal(promotion.result.promotions.length, 1);

    const late = await lifecycle.settlePayment({
      merchantId: f.merchant,
      reservationId: owner.reservation.id,
      provider: 'paystack',
      providerTransactionId: `late-${id()}`,
      amountMinor: 10000,
      currency: 'GHS',
    });
    assert.equal(late.outcome, 'reconciliation_required');
    assert.equal(late.inventoryReleased, false);

    const inv = await inventory(f.sku);
    assert.equal(inv.available_qty, 0);
    assert.equal(inv.reserved_qty, 1);
    assert.equal(inv.sold_qty, 0);

    const old = (await poolA.query('SELECT status FROM reservations WHERE id=$1', [owner.reservation.id])).rows[0];
    assert.equal(old.status, 'reconciliation_required');
  });

  test('C07: retry after response loss returns original result without creating a second reservation', async () => {
    const f = await fixture(2);
    const service = new PgReservationService({ pool: poolA });
    const buyer = id();
    const key = idem('c07');
    const event = `wa-${id()}`;
    const input = {
      merchantId: f.merchant, sessionId: f.session, inventoryVariantId: f.sku,
      buyerId: buyer, idempotencyKey: key, providerEventId: event,
    };

    const first = await service.acceptBuyerIntent(input);
    const replay = await service.acceptBuyerIntent(input);
    assert.deepEqual(replay, first);

    const count = await poolA.query(`SELECT COUNT(*)::int AS count FROM reservations
      WHERE merchant_id=$1 AND buyer_id=$2 AND inventory_variant_id=$3`, [f.merchant, buyer, f.sku]);
    assert.equal(count.rows[0].count, 1);
    const inv = await inventory(f.sku);
    assert.equal(inv.available_qty, 1);
    assert.equal(inv.reserved_qty, 1);
  });

  test('C10: two independent application pools racing for last unit yield exactly one reservation', async () => {
    const f = await fixture(1);
    const a = new PgReservationService({ pool: poolA });
    const b = new PgReservationService({ pool: poolB });

    const [one, two] = await Promise.all([
      a.acceptBuyerIntent({
        merchantId: f.merchant, sessionId: f.session, inventoryVariantId: f.sku,
        buyerId: id(), idempotencyKey: idem('c10-a'), providerEventId: `wa-${id()}`,
      }),
      b.acceptBuyerIntent({
        merchantId: f.merchant, sessionId: f.session, inventoryVariantId: f.sku,
        buyerId: id(), idempotencyKey: idem('c10-b'), providerEventId: `wa-${id()}`,
      }),
    ]);

    assert.equal([one, two].filter((x) => x.outcome === 'reserved').length, 1);
    assert.equal([one, two].filter((x) => x.outcome === 'waitlisted').length, 1);
    const inv = await inventory(f.sku);
    assert.equal(inv.available_qty, 0);
    assert.equal(inv.reserved_qty, 1);
  });

  test('C08: privileged force-allocation requires step-up, rechecks stock and writes audit atomically', async () => {
    const f = await fixture(1);
    const override = new PgReservationOverrideService({ pool: poolA });
    const result = await override.forceAllocate({
      merchantId: f.merchant,
      sessionId: f.session,
      inventoryVariantId: f.sku,
      buyerId: id(),
      quantity: 1,
      idempotencyKey: idem('c08'),
      actorId: 'operator-c08',
      permissions: ['reservation.force_allocate'],
      stepUpVerifiedAt: new Date().toISOString(),
      reason: 'Buyer identity and order verified by supervisor',
      expectedInventoryVersion: 0,
    });
    assert.equal(result.override, true);
    const inv = await inventory(f.sku);
    assert.equal(inv.available_qty, 0);
    assert.equal(inv.reserved_qty, 1);
    const audit = await poolA.query(`SELECT action,actor_id,reason,entity_id FROM audit_events
      WHERE merchant_id=$1 AND entity_id=$2`, [f.merchant, result.reservation.id]);
    assert.equal(audit.rowCount, 1);
    assert.equal(audit.rows[0].action, 'reservation.force_allocated');
    assert.equal(audit.rows[0].actor_id, 'operator-c08');

    await assert.rejects(() => override.forceAllocate({
      merchantId: f.merchant, sessionId: f.session, inventoryVariantId: f.sku,
      buyerId: id(), quantity: 1, idempotencyKey: idem('c08-oversell'), actorId: 'operator-c08',
      permissions: ['reservation.force_allocate'], stepUpVerifiedAt: new Date().toISOString(),
      reason: 'Second allocation must fail after stock is exhausted', expectedInventoryVersion: 1,
    }), (e) => e.code === 'OVERRIDE_STOCK_RECHECK_FAILED');
  });


  test('C09: stale seller inventory version is rejected without reservation or audit side effect', async () => {
    const f = await fixture(2);
    const override = new PgReservationOverrideService({ pool: poolA });
    await poolA.query(`UPDATE inventory_variants SET available_qty=available_qty+1,version=version+1 WHERE id=$1`, [f.sku]);

    await assert.rejects(() => override.forceAllocate({
      merchantId: f.merchant,
      sessionId: f.session,
      inventoryVariantId: f.sku,
      buyerId: id(),
      quantity: 1,
      idempotencyKey: idem('c09-stale'),
      actorId: 'operator-c09',
      permissions: ['reservation.force_allocate'],
      stepUpVerifiedAt: new Date().toISOString(),
      reason: 'Attempt using snapshot captured before concurrent inventory update',
      expectedInventoryVersion: 0,
    }), (e) => e.code === 'STALE_INVENTORY_VERSION');

    const inv = await inventory(f.sku);
    assert.equal(inv.available_qty, 3);
    assert.equal(inv.reserved_qty, 0);
    assert.equal(Number(inv.version), 1);
    const sideEffects = (await poolA.query(`SELECT
      (SELECT COUNT(*)::int FROM reservations WHERE merchant_id=$1) AS reservations,
      (SELECT COUNT(*)::int FROM audit_events WHERE merchant_id=$1) AS audits`, [f.merchant])).rows[0];
    assert.deepEqual(sideEffects, { reservations: 0, audits: 0 });
  });


  test('C11: variant switch is atomic; unavailable destination leaves original hold untouched', async () => {
    const f = await fixture(1);
    const destination = id();
    await poolA.query(`INSERT INTO inventory_variants
      (id,merchant_id,sku,available_qty,reserved_qty,sold_qty)
      VALUES ($1,$2,$3,1,0,0)`, [destination, f.merchant, `sku-${destination}`]);

    const reserve = new PgReservationService({ pool: poolA });
    const variant = new PgReservationVariantService({ pool: poolB });
    const buyer = id();
    const original = await reserve.acceptBuyerIntent({
      merchantId: f.merchant,
      sessionId: f.session,
      inventoryVariantId: f.sku,
      buyerId: buyer,
      quantity: 1,
      idempotencyKey: idem('c11-reserve'),
      providerEventId: `wa-${id()}`,
    });

    const switched = await variant.switchVariant({
      merchantId: f.merchant,
      reservationId: original.reservation.id,
      destinationInventoryVariantId: destination,
      idempotencyKey: idem('c11-switch'),
      actorType: 'buyer',
      actorId: buyer,
      reason: 'Buyer selected another available variant',
    });
    assert.equal(switched.outcome, 'switched');
    assert.equal(switched.reservation.inventory_variant_id, destination);

    const sourceAfter = await inventory(f.sku);
    const destinationAfter = await inventory(destination);
    assert.equal(sourceAfter.available_qty, 1);
    assert.equal(sourceAfter.reserved_qty, 0);
    assert.equal(destinationAfter.available_qty, 0);
    assert.equal(destinationAfter.reserved_qty, 1);

    const outbox = await poolA.query(`SELECT source_type,inventory_variant_id
      FROM lifecycle_outbox WHERE id=$1`, [switched.outboxId]);
    assert.equal(outbox.rows[0].source_type, 'variant_switch');
    assert.equal(outbox.rows[0].inventory_variant_id, f.sku);

    const unavailableDestination = id();
    await poolA.query(`INSERT INTO inventory_variants
      (id,merchant_id,sku,available_qty,reserved_qty,sold_qty)
      VALUES ($1,$2,$3,0,0,0)`, [unavailableDestination, f.merchant, `sku-${unavailableDestination}`]);

    await assert.rejects(() => variant.switchVariant({
      merchantId: f.merchant,
      reservationId: original.reservation.id,
      destinationInventoryVariantId: unavailableDestination,
      idempotencyKey: idem('c11-unavailable'),
      actorType: 'buyer',
      actorId: buyer,
      reason: 'Buyer attempted another variant with no stock',
    }), (e) => e.code === 'DESTINATION_VARIANT_UNAVAILABLE');

    const reservationAfterFailure = (await poolA.query(`SELECT inventory_variant_id
      FROM reservations WHERE id=$1`, [original.reservation.id])).rows[0];
    assert.equal(reservationAfterFailure.inventory_variant_id, destination);
    const destinationAfterFailure = await inventory(destination);
    assert.equal(destinationAfterFailure.available_qty, 0);
    assert.equal(destinationAfterFailure.reserved_qty, 1);
  });


  test('C12: closing stops new intents, cancels waitlist, drains active holds and ends with zero orphans', async () => {
    const f = await fixture(1, 1);
    const reserve = new PgReservationService({ pool: poolA });
    const shutdown = new PgLiveSessionShutdownService({ pool: poolB });

    const first = await reserve.acceptBuyerIntent({
      merchantId: f.merchant,
      sessionId: f.session,
      inventoryVariantId: f.sku,
      buyerId: id(),
      quantity: 1,
      idempotencyKey: idem('c12-reserve'),
      providerEventId: `wa-${id()}`,
    });
    const waiting = await reserve.acceptBuyerIntent({
      merchantId: f.merchant,
      sessionId: f.session,
      inventoryVariantId: f.sku,
      buyerId: id(),
      quantity: 1,
      idempotencyKey: idem('c12-wait'),
      providerEventId: `wa-${id()}`,
    });
    assert.equal(first.outcome, 'reserved');
    assert.equal(waiting.outcome, 'waitlisted');

    const closing = await shutdown.beginShutdown({
      merchantId: f.merchant,
      sessionId: f.session,
      actorId: 'operator-c12',
      reason: 'Seller ended the LIVE session after the sales window',
      idempotencyKey: idem('c12-close'),
    });
    assert.equal(closing.status, 'closing');
    assert.equal(closing.cancelledWaitlistCount, 1);

    await assert.rejects(() => reserve.acceptBuyerIntent({
      merchantId: f.merchant,
      sessionId: f.session,
      inventoryVariantId: f.sku,
      buyerId: id(),
      quantity: 1,
      idempotencyKey: idem('c12-after-close'),
      providerEventId: `wa-${id()}`,
    }), (e) => e.code === 'SESSION_NOT_LIVE');

    await new Promise((resolve) => setTimeout(resolve, 1100));

    const ended = await shutdown.finalizeShutdown({
      merchantId: f.merchant,
      sessionId: f.session,
      actorId: 'operator-c12',
      reason: 'All active holds reached their server-authoritative expiry',
    });
    assert.equal(ended.outcome, 'ended');

    const state = (await poolA.query(`SELECT
      (SELECT status FROM live_sessions WHERE id=$1) AS session_status,
      (SELECT COUNT(*)::int FROM reservations
        WHERE live_session_id=$1 AND status IN ('active','payment_pending')) AS active_holds,
      (SELECT COUNT(*)::int FROM waitlist_entries
        WHERE live_session_id=$1 AND status='waiting') AS waiting`,
      [f.session])).rows[0];
    assert.deepEqual(state, { session_status: 'ended', active_holds: 0, waiting: 0 });

    const inv = await inventory(f.sku);
    assert.equal(inv.available_qty, 1);
    assert.equal(inv.reserved_qty, 0);
  });

}
