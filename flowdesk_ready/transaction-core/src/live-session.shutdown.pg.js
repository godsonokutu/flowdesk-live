'use strict';

const { DomainError, stableHash } = require('./reservation.pg');

class PgLiveSessionShutdownService {
  constructor({ pool }) {
    if (!pool) throw new TypeError('pool required');
    this.pool = pool;
  }

  async beginShutdown({
    merchantId,
    sessionId,
    actorId,
    reason,
    idempotencyKey,
  }) {
    if (!merchantId || !sessionId || !actorId) {
      throw new DomainError('INVALID_INPUT', 'merchantId, sessionId and actorId are required', 400);
    }
    if (typeof reason !== 'string' || reason.trim().length < 8 || reason.trim().length > 500) {
      throw new DomainError('INVALID_SHUTDOWN_REASON', 'shutdown reason must be 8-500 characters', 400);
    }
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 16 || idempotencyKey.length > 200) {
      throw new DomainError('INVALID_IDEMPOTENCY_KEY', 'idempotency key must be 16-200 characters', 400);
    }

    const normalizedReason = reason.trim();
    const requestHash = stableHash({
      sessionId,
      actorId,
      reason: normalizedReason,
      policy: 'drain_holds',
    });

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const idem = await client.query(`INSERT INTO idempotency_requests
        (merchant_id,idempotency_key,request_hash,operation,expires_at)
        VALUES ($1,$2,$3,'begin_live_session_shutdown',now()+interval '24 hours')
        ON CONFLICT (merchant_id,idempotency_key) DO NOTHING
        RETURNING request_hash,response_body`,
        [merchantId, idempotencyKey, requestHash]);

      if (idem.rowCount === 0) {
        const prior = (await client.query(`SELECT request_hash,response_body
          FROM idempotency_requests
          WHERE merchant_id=$1 AND idempotency_key=$2
          FOR UPDATE`, [merchantId, idempotencyKey])).rows[0];

        if (!prior) throw new DomainError('IDEMPOTENCY_RACE', 'idempotency record disappeared', 503);
        if (prior.request_hash !== requestHash) {
          throw new DomainError(
            'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD',
            'idempotency key already used for another shutdown request'
          );
        }
        if (!prior.response_body) {
          throw new DomainError('IDEMPOTENCY_REQUEST_IN_PROGRESS', 'matching shutdown request is still in progress');
        }
        await client.query('COMMIT');
        return { ...prior.response_body, deduplicated: true };
      }

      // This row lock is the shutdown cut-over boundary. Any buyer-intent
      // transaction that already holds FOR SHARE may finish first; once this
      // UPDATE lock is acquired and committed, new intents observe `closing`
      // and fail before inventory mutation.
      const session = (await client.query(`SELECT
          id,status,closing_started_at,close_policy,ended_at
        FROM live_sessions
        WHERE id=$1 AND merchant_id=$2
        FOR UPDATE`, [sessionId, merchantId])).rows[0];

      if (!session) throw new DomainError('SESSION_NOT_FOUND', 'LIVE session not found', 404);

      if (session.status === 'ended') {
        const result = {
          outcome: 'already_ended',
          sessionId,
          status: 'ended',
          endedAt: session.ended_at,
        };
        await client.query(`UPDATE idempotency_requests
          SET response_status=200,response_body=$3::jsonb
          WHERE merchant_id=$1 AND idempotency_key=$2`,
          [merchantId, idempotencyKey, JSON.stringify(result)]);
        await client.query('COMMIT');
        return result;
      }

      if (!['live', 'closing'].includes(session.status)) {
        throw new DomainError('SESSION_NOT_CLOSABLE', `cannot shut down session from ${session.status}`);
      }

      const startedNow = session.status === 'live';
      let closingStartedAt = session.closing_started_at;

      if (startedNow) {
        const updated = (await client.query(`UPDATE live_sessions
          SET status='closing',
              closing_started_at=COALESCE(closing_started_at,now()),
              close_policy='drain_holds',
              updated_at=now()
          WHERE id=$1 AND merchant_id=$2
          RETURNING closing_started_at`,
          [sessionId, merchantId])).rows[0];
        closingStartedAt = updated.closing_started_at;
      }

      // Waitlist ownership ends at the shutdown cut-over. Existing holds remain
      // valid until their original server-authoritative expiry; no new waitlist
      // reservation may be manufactured while status=closing.
      const cancelledWaitlist = await client.query(`UPDATE waitlist_entries
        SET status='cancelled'
        WHERE merchant_id=$1 AND live_session_id=$2 AND status='waiting'
        RETURNING id`, [merchantId, sessionId]);

      const holdSummary = (await client.query(`SELECT
          COUNT(*)::int AS active_hold_count,
          MIN(expires_at) AS next_expiry_at,
          MAX(expires_at) AS last_expiry_at
        FROM reservations
        WHERE merchant_id=$1 AND live_session_id=$2
          AND status IN ('active','payment_pending')`,
        [merchantId, sessionId])).rows[0];

      if (startedNow) {
        await client.query(`INSERT INTO audit_events
          (id,merchant_id,actor_type,actor_id,action,entity_type,entity_id,reason,metadata)
          VALUES (gen_random_uuid(),$1,'operator',$2,'live_session.shutdown_started',
                  'live_session',$3,$4,$5::jsonb)`,
          [
            merchantId,
            actorId,
            sessionId,
            normalizedReason,
            JSON.stringify({
              policy: 'drain_holds',
              cancelledWaitlistCount: cancelledWaitlist.rowCount,
              activeHoldCount: Number(holdSummary.active_hold_count || 0),
              nextExpiryAt: holdSummary.next_expiry_at,
              lastExpiryAt: holdSummary.last_expiry_at,
            }),
          ]);
      }

      const result = {
        outcome: 'closing',
        sessionId,
        status: 'closing',
        policy: 'drain_holds',
        closingStartedAt,
        cancelledWaitlistCount: cancelledWaitlist.rowCount,
        activeHoldCount: Number(holdSummary.active_hold_count || 0),
        nextExpiryAt: holdSummary.next_expiry_at || null,
        lastExpiryAt: holdSummary.last_expiry_at || null,
      };

      await client.query(`UPDATE idempotency_requests
        SET response_status=202,response_body=$3::jsonb
        WHERE merchant_id=$1 AND idempotency_key=$2`,
        [merchantId, idempotencyKey, JSON.stringify(result)]);

      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  async finalizeShutdown({ merchantId, sessionId, actorId, reason = 'All active holds resolved or expired' }) {
    if (!merchantId || !sessionId || !actorId) {
      throw new DomainError('INVALID_INPUT', 'merchantId, sessionId and actorId are required', 400);
    }
    if (typeof reason !== 'string' || reason.trim().length < 8 || reason.trim().length > 500) {
      throw new DomainError('INVALID_SHUTDOWN_REASON', 'shutdown reason must be 8-500 characters', 400);
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const observed = (await client.query(`SELECT status
        FROM live_sessions
        WHERE id=$1 AND merchant_id=$2`, [sessionId, merchantId])).rows[0];
      if (!observed) throw new DomainError('SESSION_NOT_FOUND', 'LIVE session not found', 404);
      if (observed.status === 'ended') {
        await client.query('COMMIT');
        return { outcome: 'already_ended', sessionId, status: 'ended' };
      }
      if (observed.status !== 'closing') {
        throw new DomainError('SESSION_NOT_CLOSING', 'session must enter closing before finalization');
      }

      // Lock active reservations before the session row. Variant switching uses
      // reservation -> session -> inventory; preserving that order avoids a
      // shutdown/variant deadlock at the cut-over boundary.
      const holds = (await client.query(`SELECT
          id,inventory_variant_id,quantity,status,expires_at
        FROM reservations
        WHERE merchant_id=$1 AND live_session_id=$2
          AND status IN ('active','payment_pending')
        ORDER BY id
        FOR UPDATE`, [merchantId, sessionId])).rows;

      const session = (await client.query(`SELECT
          id,status,closing_started_at,close_policy,ended_at,now() AS db_now
        FROM live_sessions
        WHERE id=$1 AND merchant_id=$2
        FOR UPDATE`, [sessionId, merchantId])).rows[0];

      if (session.status === 'ended') {
        await client.query('COMMIT');
        return { outcome: 'already_ended', sessionId, status: 'ended', endedAt: session.ended_at };
      }
      if (session.status !== 'closing') {
        throw new DomainError('SESSION_NOT_CLOSING', 'session left closing state during finalization');
      }

      const now = new Date(session.db_now);
      const futureHolds = holds.filter((row) => new Date(row.expires_at) > now);

      // Defensive cleanup: a concurrent pre-cutover request could have committed
      // before beginShutdown obtained the session lock. Any waiting rows are
      // terminalized before reporting drain state.
      const cancelledWaitlist = await client.query(`UPDATE waitlist_entries
        SET status='cancelled'
        WHERE merchant_id=$1 AND live_session_id=$2 AND status='waiting'
        RETURNING id`, [merchantId, sessionId]);

      if (futureHolds.length > 0) {
        const expiries = futureHolds.map((row) => new Date(row.expires_at).toISOString()).sort();
        await client.query('COMMIT');
        return {
          outcome: 'draining',
          sessionId,
          status: 'closing',
          activeHoldCount: futureHolds.length,
          nextExpiryAt: expiries[0],
          lastExpiryAt: expiries[expiries.length - 1],
          cancelledWaitlistCount: cancelledWaitlist.rowCount,
        };
      }

      const totals = new Map();
      for (const hold of holds) {
        const qty = Number(hold.quantity);
        if (!Number.isSafeInteger(qty) || qty < 1) {
          throw new DomainError('INVALID_RESERVATION_QUANTITY', 'reservation quantity is invalid', 500);
        }
        totals.set(hold.inventory_variant_id, (totals.get(hold.inventory_variant_id) || 0) + qty);
      }

      const variantIds = [...totals.keys()].sort();
      if (variantIds.length > 0) {
        const inventoryRows = (await client.query(`SELECT id,reserved_qty
          FROM inventory_variants
          WHERE merchant_id=$1 AND id = ANY($2::uuid[])
          ORDER BY id
          FOR UPDATE`, [merchantId, variantIds])).rows;

        if (inventoryRows.length !== variantIds.length) {
          throw new DomainError('INVENTORY_NOT_FOUND', 'one or more shutdown inventory rows are missing', 503);
        }

        const byId = new Map(inventoryRows.map((row) => [row.id, row]));
        for (const variantId of variantIds) {
          const releaseQty = totals.get(variantId);
          const row = byId.get(variantId);
          if (Number(row.reserved_qty) < releaseQty) {
            throw new DomainError(
              'INVENTORY_ACCOUNTING_CONFLICT',
              'shutdown release exceeds authoritative reserved stock',
              503
            );
          }
          const released = await client.query(`UPDATE inventory_variants
            SET available_qty=available_qty+$1,
                reserved_qty=reserved_qty-$1,
                version=version+1
            WHERE id=$2 AND merchant_id=$3 AND reserved_qty >= $1
            RETURNING version`,
            [releaseQty, variantId, merchantId]);
          if (released.rowCount !== 1) {
            throw new DomainError('INVENTORY_ACCOUNTING_CONFLICT', 'shutdown inventory release failed', 503);
          }
        }
      }

      let expiredCount = 0;
      if (holds.length > 0) {
        const ids = holds.map((row) => row.id);
        const expired = await client.query(`UPDATE reservations
          SET status='expired',updated_at=now()
          WHERE merchant_id=$1 AND id = ANY($2::uuid[])
            AND status IN ('active','payment_pending')
          RETURNING id`, [merchantId, ids]);
        expiredCount = expired.rowCount;
        if (expiredCount !== holds.length) {
          throw new DomainError('RESERVATION_STATE_CONFLICT', 'shutdown hold set changed during finalization', 503);
        }
      }

      const unresolved = (await client.query(`SELECT
          COUNT(*) FILTER (WHERE status IN ('active','payment_pending'))::int AS active_holds,
          (SELECT COUNT(*)::int FROM waitlist_entries
            WHERE merchant_id=$1 AND live_session_id=$2 AND status='waiting') AS waiting
        FROM reservations
        WHERE merchant_id=$1 AND live_session_id=$2`,
        [merchantId, sessionId])).rows[0];

      if (Number(unresolved.active_holds) !== 0 || Number(unresolved.waiting) !== 0) {
        throw new DomainError('SESSION_CLOSE_INVARIANT_FAILED', 'session still has unresolved reservation/waitlist state', 503);
      }

      const ended = (await client.query(`UPDATE live_sessions
        SET status='ended',ended_at=COALESCE(ended_at,now()),updated_at=now()
        WHERE id=$1 AND merchant_id=$2 AND status='closing'
        RETURNING ended_at`, [sessionId, merchantId])).rows[0];

      if (!ended) {
        throw new DomainError('SESSION_STATE_CONFLICT', 'session could not transition closing -> ended', 503);
      }

      const pendingLifecycle = (await client.query(`SELECT COUNT(*)::int AS count
        FROM lifecycle_outbox
        WHERE merchant_id=$1 AND live_session_id=$2 AND status='pending'`,
        [merchantId, sessionId])).rows[0];

      await client.query(`INSERT INTO audit_events
        (id,merchant_id,actor_type,actor_id,action,entity_type,entity_id,reason,metadata)
        VALUES (gen_random_uuid(),$1,'operator',$2,'live_session.ended',
                'live_session',$3,$4,$5::jsonb)`,
        [
          merchantId,
          actorId,
          sessionId,
          reason.trim(),
          JSON.stringify({
            policy: 'drain_holds',
            expiredReservationCount: expiredCount,
            releasedQuantity: [...totals.values()].reduce((sum, qty) => sum + qty, 0),
            cancelledWaitlistCount: cancelledWaitlist.rowCount,
            pendingLifecycleJobs: Number(pendingLifecycle.count || 0),
            lifecyclePolicy: 'workers observe non-live session and complete without promotion',
          }),
        ]);

      await client.query('COMMIT');

      return {
        outcome: 'ended',
        sessionId,
        status: 'ended',
        endedAt: ended.ended_at,
        expiredReservationCount: expiredCount,
        releasedQuantity: [...totals.values()].reduce((sum, qty) => sum + qty, 0),
        cancelledWaitlistCount: cancelledWaitlist.rowCount,
        pendingLifecycleJobs: Number(pendingLifecycle.count || 0),
      };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = { PgLiveSessionShutdownService };
