'use strict';

class DomainError extends Error {
  constructor(code, message, status = 409) { super(message); this.code = code; this.status = status; }
}

class PgLifecycleOperationsService {
  constructor({ pool, authorize }) {
    if (!pool) throw new TypeError('pool required');
    if (typeof authorize !== 'function') throw new TypeError('authorize callback required');
    this.pool = pool;
    this.authorize = authorize;
  }

  async getHealth({ merchantId, actorId }) {
    await this.authorize({ merchantId, actorId, permission: 'lifecycle.health.read' });
    const client = await this.pool.connect();
    try {
      const summary = (await client.query(`SELECT
        COUNT(*) FILTER (WHERE status='pending')::bigint AS pending_count,
        COUNT(*) FILTER (WHERE status='dead_letter')::bigint AS dead_letter_count,
        COUNT(*) FILTER (WHERE status='pending' AND attempts > 0)::bigint AS retrying_count,
        EXTRACT(EPOCH FROM (now() - MIN(created_at) FILTER (WHERE status='pending')))::double precision AS oldest_pending_age_seconds,
        MAX(completed_at) FILTER (WHERE status='completed') AS last_completed_at
      FROM lifecycle_outbox
      WHERE merchant_id=$1`, [merchantId])).rows[0];

      const byType = (await client.query(`SELECT event_type,status,COUNT(*)::bigint AS count
        FROM lifecycle_outbox
        WHERE merchant_id=$1 AND created_at >= now()-interval '24 hours'
        GROUP BY event_type,status
        ORDER BY event_type,status`, [merchantId])).rows;

      return {
        pendingCount: Number(summary?.pending_count || 0),
        deadLetterCount: Number(summary?.dead_letter_count || 0),
        retryingCount: Number(summary?.retrying_count || 0),
        oldestPendingAgeSeconds: summary?.oldest_pending_age_seconds == null ? null : Number(summary.oldest_pending_age_seconds),
        lastCompletedAt: summary?.last_completed_at || null,
        last24h: byType.map(row=>({eventType:row.event_type,status:row.status,count:Number(row.count)})),
      };
    } finally { client.release(); }
  }

  async listDeadLetters({ merchantId, actorId, limit = 50, beforeCreatedAt = null }) {
    await this.authorize({ merchantId, actorId, permission: 'lifecycle.dead_letter.read' });
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DomainError('INVALID_LIMIT', 'limit must be between 1 and 100', 400);
    const client = await this.pool.connect();
    try {
      const result = await client.query(`SELECT
          id,event_type,source_type,source_id,live_session_id,inventory_variant_id,
          attempts,last_error,payload,created_at,available_at
        FROM lifecycle_outbox
        WHERE merchant_id=$1 AND status='dead_letter'
          AND ($2::timestamptz IS NULL OR created_at < $2::timestamptz)
        ORDER BY created_at DESC,id DESC
        LIMIT $3`, [merchantId, beforeCreatedAt, limit]);
      return result.rows;
    } finally { client.release(); }
  }

  async replayDeadLetter({ merchantId, actorId, outboxId, reason }) {
    await this.authorize({ merchantId, actorId, permission: 'lifecycle.dead_letter.replay' });
    if (!outboxId) throw new DomainError('INVALID_INPUT', 'outboxId required', 400);
    if (typeof reason !== 'string' || reason.trim().length < 8 || reason.trim().length > 500) {
      throw new DomainError('INVALID_REPLAY_REASON', 'replay reason must be 8-500 characters', 400);
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const job = (await client.query(`SELECT id,event_type,source_type,source_id,payload,status,attempts
        FROM lifecycle_outbox
        WHERE id=$1 AND merchant_id=$2
        FOR UPDATE`, [outboxId, merchantId])).rows[0];
      if (!job) throw new DomainError('OUTBOX_NOT_FOUND', 'outbox event not found', 404);
      if (job.status !== 'dead_letter') throw new DomainError('OUTBOX_NOT_DEAD_LETTER', 'only dead-letter events can be replayed');

      // Payload/source identity is immutable during replay. Operators can retry the
      // same durable event, not rewrite it into a different transaction.
      await client.query(`UPDATE lifecycle_outbox
        SET status='pending',attempts=0,available_at=now(),last_error=NULL,
            result_body=NULL,completed_at=NULL
        WHERE id=$1`, [outboxId]);

      await client.query(`INSERT INTO audit_events
        (id,merchant_id,actor_type,actor_id,action,entity_type,entity_id,reason,metadata)
        VALUES (gen_random_uuid(),$1,'operator',$2,'lifecycle.dead_letter.replayed',
                'lifecycle_outbox',$3,$4,$5::jsonb)`, [
          merchantId,
          actorId,
          outboxId,
          reason.trim(),
          JSON.stringify({
            eventType: job.event_type,
            sourceType: job.source_type,
            sourceId: job.source_id,
            priorAttempts: job.attempts,
          }),
        ]);

      await client.query('COMMIT');
      return { outcome: 'replay_queued', outboxId };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally { client.release(); }
  }
}

module.exports = { PgLifecycleOperationsService, DomainError };
