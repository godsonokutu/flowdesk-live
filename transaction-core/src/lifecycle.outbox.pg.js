'use strict';

class DomainError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const RETRYABLE_SQLSTATES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available
  '08000', '08001', '08003', '08004', '08006', '08007', '08P01',
  '53300', // too_many_connections
  '57P01', '57P02', '57P03',
]);

function isRetryableError(error) {
  if (!error) return false;
  if (error instanceof DomainError) return error.status >= 500;
  return RETRYABLE_SQLSTATES.has(error.code);
}

function sanitizeError(error) {
  const code = error?.code ? String(error.code) : 'UNKNOWN';
  const message = error?.message ? String(error.message) : 'Unknown lifecycle worker error';
  return `${code}: ${message}`.slice(0, 2000);
}

/**
 * Must be invoked inside the same database transaction that made inventory
 * available. The unique dedupe key makes enqueue replay-safe.
 */
async function enqueueInventoryAvailable(client, {
  merchantId,
  sessionId,
  inventoryVariantId,
  sourceType,
  sourceId = null,
  reason,
}) {
  if (!client) throw new TypeError('client required');
  if (!merchantId || !sessionId || !inventoryVariantId || !sourceType || !sourceId) {
    throw new DomainError('INVALID_OUTBOX_INPUT', 'outbox identifiers including sourceId are required', 400);
  }

  const dedupeKey = `inventory_available:${sourceType}:${sourceId}`;
  const payload = { reason: reason || sourceType };

  const inserted = await client.query(`INSERT INTO lifecycle_outbox
    (merchant_id,event_type,source_type,source_id,live_session_id,inventory_variant_id,dedupe_key,payload)
    VALUES ($1,'inventory_available',$2,$3,$4,$5,$6,$7::jsonb)
    ON CONFLICT (merchant_id,dedupe_key) DO NOTHING
    RETURNING id`, [
      merchantId,
      sourceType,
      sourceId,
      sessionId,
      inventoryVariantId,
      dedupeKey,
      JSON.stringify(payload),
    ]);

  return {
    enqueued: inserted.rowCount === 1,
    outboxId: inserted.rows?.[0]?.id || null,
    dedupeKey,
  };
}

/**
 * Database-local lifecycle worker.
 *
 * A job and every promotion it causes commit in ONE transaction. There is no
 * "promotion committed but outbox completion lost" window. If the process dies
 * before COMMIT, PostgreSQL rolls back both the promotion and job completion.
 *
 * Worker-level SKIP LOCKED is safe because jobs are independent. Buyer-level
 * waitlist selection deliberately does NOT use SKIP LOCKED: strict FIFO means
 * the head buyer may not be bypassed merely because their row is temporarily
 * locked by another transaction.
 */
class PgLifecycleOutboxWorker {
  constructor({
    pool,
    maxAttempts = 8,
    baseRetryMs = 1000,
    maxRetryMs = 300000,
    random = Math.random,
  }) {
    if (!pool) throw new TypeError('pool required');
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new TypeError('maxAttempts must be >= 1');
    this.pool = pool;
    this.maxAttempts = maxAttempts;
    this.baseRetryMs = baseRetryMs;
    this.maxRetryMs = maxRetryMs;
    this.random = random;
  }

  retryDelayMs(attempt) {
    const exponential = Math.min(this.maxRetryMs, this.baseRetryMs * (2 ** Math.max(0, attempt - 1)));
    const jitter = 0.75 + (this.random() * 0.5); // 0.75x .. 1.25x
    return Math.max(1, Math.floor(exponential * jitter));
  }

  async processNext() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const job = (await client.query(`SELECT
          id,merchant_id,event_type,source_type,source_id,live_session_id,
          inventory_variant_id,dedupe_key,payload,attempts
        FROM lifecycle_outbox
        WHERE status='pending' AND available_at <= now()
        ORDER BY available_at ASC, created_at ASC, id ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED`)).rows[0];

      if (!job) {
        await client.query('COMMIT');
        return { outcome: 'idle' };
      }

      const attempt = Number(job.attempts) + 1;
      await client.query(`UPDATE lifecycle_outbox
        SET attempts=$2,last_error=NULL
        WHERE id=$1`, [job.id, attempt]);

      await client.query('SAVEPOINT lifecycle_handler');

      try {
        const result = await this.handleJob(client, job);
        await client.query(`UPDATE lifecycle_outbox
          SET status='completed',completed_at=now(),result_body=$2::jsonb,last_error=NULL
          WHERE id=$1`, [job.id, JSON.stringify(result)]);
        await client.query('COMMIT');
        return { outcome: 'completed', jobId: job.id, attempt, result };
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT lifecycle_handler');

        const retryable = isRetryableError(error);
        const errorText = sanitizeError(error);
        if (retryable && attempt < this.maxAttempts) {
          const delayMs = this.retryDelayMs(attempt);
          await client.query(`UPDATE lifecycle_outbox
            SET status='pending',attempts=$2,
                available_at=now()+($3::bigint * interval '1 millisecond'),
                last_error=$4
            WHERE id=$1`, [job.id, attempt, delayMs, errorText]);
          await client.query('COMMIT');
          return { outcome: 'retry_scheduled', jobId: job.id, attempt, delayMs, error: errorText };
        }

        await client.query(`UPDATE lifecycle_outbox
          SET status='dead_letter',attempts=$2,last_error=$3
          WHERE id=$1`, [job.id, attempt, errorText]);
        await client.query('COMMIT');
        return { outcome: 'dead_letter', jobId: job.id, attempt, error: errorText };
      }
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  async handleJob(client, job) {
    if (job.event_type !== 'inventory_available') {
      throw new DomainError('UNSUPPORTED_LIFECYCLE_EVENT', `Unsupported lifecycle event: ${job.event_type}`, 400);
    }
    return this.promoteEligibleWaitlist(client, job);
  }

  async promoteEligibleWaitlist(client, job) {
    const session = (await client.query(`SELECT id,status,reservation_ttl_seconds
      FROM live_sessions
      WHERE id=$1 AND merchant_id=$2
      FOR SHARE`, [job.live_session_id, job.merchant_id])).rows[0];

    if (!session || session.status !== 'live') {
      return { outcome: 'session_not_live', promotions: [] };
    }

    const inventory = (await client.query(`SELECT id,available_qty,reserved_qty
      FROM inventory_variants
      WHERE id=$1 AND merchant_id=$2
      FOR UPDATE`, [job.inventory_variant_id, job.merchant_id])).rows[0];

    if (!inventory) {
      throw new DomainError('INVENTORY_NOT_FOUND', 'inventory variant not found for lifecycle job', 404);
    }

    let available = Number(inventory.available_qty);
    const promotions = [];

    while (available > 0) {
      const next = (await client.query(`SELECT id,buyer_id,quantity,position_seq
        FROM waitlist_entries
        WHERE merchant_id=$1
          AND live_session_id=$2
          AND inventory_variant_id=$3
          AND status='waiting'
        ORDER BY position_seq ASC
        LIMIT 1
        FOR UPDATE`, [job.merchant_id, job.live_session_id, job.inventory_variant_id])).rows[0];

      if (!next) break;

      const quantity = Number(next.quantity);
      if (!Number.isSafeInteger(quantity) || quantity < 1) {
        throw new DomainError('INVALID_WAITLIST_QUANTITY', 'waitlist quantity is invalid', 500);
      }

      // Strict FIFO: do not skip the head buyer to satisfy a smaller later order.
      if (quantity > available) {
        return {
          outcome: promotions.length ? 'promoted_then_head_blocked' : 'head_waiting_for_more_stock',
          promotions,
          blockedWaitlistEntryId: next.id,
          availableQty: available,
          requiredQty: quantity,
        };
      }

      const reservation = (await client.query(`INSERT INTO reservations
        (id,merchant_id,live_session_id,inventory_variant_id,buyer_id,quantity,status,expires_at,promotion_outbox_id)
        VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'active',now()+make_interval(secs=>$6),$7)
        RETURNING id,expires_at,quantity`, [
          job.merchant_id,
          job.live_session_id,
          job.inventory_variant_id,
          next.buyer_id,
          quantity,
          session.reservation_ttl_seconds,
          job.id,
        ])).rows[0];

      const waitlistUpdated = await client.query(`UPDATE waitlist_entries
        SET status='promoted',promoted_reservation_id=$2,promoted_by_outbox_id=$3
        WHERE id=$1 AND status='waiting'`, [next.id, reservation.id, job.id]);
      if (waitlistUpdated.rowCount !== 1) {
        throw new DomainError('WAITLIST_STATE_CONFLICT', 'waitlist entry changed during promotion', 503);
      }

      const inventoryUpdated = await client.query(`UPDATE inventory_variants
        SET available_qty=available_qty-$1,reserved_qty=reserved_qty+$1,version=version+1
        WHERE id=$2 AND merchant_id=$3 AND available_qty >= $1`, [
          quantity,
          job.inventory_variant_id,
          job.merchant_id,
        ]);
      if (inventoryUpdated.rowCount !== 1) {
        throw new DomainError('INVENTORY_ACCOUNTING_CONFLICT', 'promotion could not claim available inventory', 503);
      }

      await client.query(`INSERT INTO audit_events
        (id,merchant_id,actor_type,actor_id,action,entity_type,entity_id,reason,metadata)
        VALUES (gen_random_uuid(),$1,'system',NULL,'waitlist.promoted','reservation',$2,
                'inventory_available_outbox',$3::jsonb)`, [
          job.merchant_id,
          reservation.id,
          JSON.stringify({
            outboxId: job.id,
            waitlistEntryId: next.id,
            sourceType: job.source_type,
            sourceId: job.source_id,
            quantity,
          }),
        ]);

      promotions.push({
        waitlistEntryId: next.id,
        reservationId: reservation.id,
        expiresAt: reservation.expires_at,
        quantity,
      });
      available -= quantity;
    }

    return {
      outcome: promotions.length ? 'promoted' : 'no_waiting_buyer',
      promotions,
      remainingAvailableQty: available,
    };
  }
}

module.exports = {
  DomainError,
  PgLifecycleOutboxWorker,
  enqueueInventoryAvailable,
  isRetryableError,
};
