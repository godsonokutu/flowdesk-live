'use strict';
const { DomainError, stableHash } = require('./reservation.pg');
const { normalizeExpectedInventoryVersion, assertInventoryVersionMatch } = require('./inventory.version-precondition');

const PERMISSION = 'reservation.force_allocate';

class PgReservationOverrideService {
  constructor({ pool, clock = () => new Date() }) {
    if (!pool) throw new TypeError('pool required');
    this.pool = pool;
    this.clock = clock;
  }

  async forceAllocate(input) {
    const {
      merchantId, sessionId, inventoryVariantId, buyerId, quantity = 1,
      idempotencyKey, actorId, permissions = [], stepUpVerifiedAt, reason, expectedInventoryVersion,
    } = input;

    if (!merchantId || !sessionId || !inventoryVariantId || !buyerId || !actorId) {
      throw new DomainError('INVALID_INPUT', 'required override identifiers missing', 400);
    }
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new DomainError('INVALID_QUANTITY', 'quantity must be a positive integer', 400);
    }
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 16 || idempotencyKey.length > 200) {
      throw new DomainError('INVALID_IDEMPOTENCY_KEY', 'idempotency key must be 16-200 characters', 400);
    }
    if (!Array.isArray(permissions) || !permissions.includes(PERMISSION)) {
      throw new DomainError('OVERRIDE_PERMISSION_REQUIRED', `permission ${PERMISSION} required`, 403);
    }
    if (typeof reason !== 'string' || reason.trim().length < 8 || reason.trim().length > 500) {
      throw new DomainError('OVERRIDE_REASON_REQUIRED', 'override reason must be 8-500 characters', 400);
    }
    const normalizedExpectedVersion = normalizeExpectedInventoryVersion(expectedInventoryVersion);

    const verifiedAt = new Date(stepUpVerifiedAt);
    const now = this.clock();
    if (!stepUpVerifiedAt || Number.isNaN(verifiedAt.getTime()) || verifiedAt > now || now - verifiedAt > 10 * 60 * 1000) {
      throw new DomainError('STEP_UP_REQUIRED', 'fresh step-up verification required', 403);
    }

    const requestHash = stableHash({ sessionId, inventoryVariantId, buyerId, quantity, actorId, reason: reason.trim(), expectedInventoryVersion: normalizedExpectedVersion });
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const idem = await client.query(`INSERT INTO idempotency_requests
        (merchant_id,idempotency_key,request_hash,operation,expires_at)
        VALUES ($1,$2,$3,'force_allocation',now()+interval '24 hours')
        ON CONFLICT (merchant_id,idempotency_key) DO NOTHING
        RETURNING request_hash,response_body`, [merchantId, idempotencyKey, requestHash]);
      if (idem.rowCount === 0) {
        const prior = (await client.query(`SELECT request_hash,response_body FROM idempotency_requests
          WHERE merchant_id=$1 AND idempotency_key=$2 FOR UPDATE`, [merchantId, idempotencyKey])).rows[0];
        if (!prior) throw new DomainError('IDEMPOTENCY_RACE', 'idempotency record disappeared', 503);
        if (prior.request_hash !== requestHash) throw new DomainError('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD', 'idempotency key already used for another request');
        if (prior.response_body) { await client.query('COMMIT'); return { ...prior.response_body, deduplicated: true }; }
        throw new DomainError('IDEMPOTENCY_REQUEST_IN_PROGRESS', 'matching request is still in progress');
      }

      const session = (await client.query(`SELECT id,status,reservation_ttl_seconds FROM live_sessions
        WHERE id=$1 AND merchant_id=$2 FOR SHARE`, [sessionId, merchantId])).rows[0];
      if (!session || session.status !== 'live') throw new DomainError('SESSION_NOT_LIVE', 'LIVE session is not active');

      const inventory = (await client.query(`SELECT id,available_qty,reserved_qty,version FROM inventory_variants
        WHERE id=$1 AND merchant_id=$2 FOR UPDATE`, [inventoryVariantId, merchantId])).rows[0];
      if (!inventory) throw new DomainError('INVENTORY_NOT_FOUND', 'inventory variant not found', 404);
      try {
        assertInventoryVersionMatch(inventory.version, normalizedExpectedVersion);
      } catch (error) {
        if (error?.code) throw new DomainError(error.code, error.message, error.status);
        throw error;
      }
      if (Number(inventory.available_qty) < quantity) {
        throw new DomainError('OVERRIDE_STOCK_RECHECK_FAILED', 'force allocation cannot oversell current authoritative stock');
      }

      const reservation = (await client.query(`INSERT INTO reservations
        (id,merchant_id,live_session_id,inventory_variant_id,buyer_id,quantity,status,expires_at)
        VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'active',now()+make_interval(secs=>$6))
        RETURNING id,status,expires_at,quantity`, [merchantId, sessionId, inventoryVariantId, buyerId, quantity, session.reservation_ttl_seconds])).rows[0];

      const updated = await client.query(`UPDATE inventory_variants SET
        available_qty=available_qty-$1,reserved_qty=reserved_qty+$1,version=version+1
        WHERE id=$2 AND merchant_id=$3 AND available_qty >= $1 RETURNING version`, [quantity, inventoryVariantId, merchantId]);
      if (updated.rowCount !== 1) throw new DomainError('INVENTORY_ACCOUNTING_CONFLICT', 'override could not claim inventory', 503);

      await client.query(`INSERT INTO audit_events
        (id,merchant_id,actor_type,actor_id,action,entity_type,entity_id,reason,metadata)
        VALUES (gen_random_uuid(),$1,'operator',$2,'reservation.force_allocated','reservation',$3,$4,$5::jsonb)`,
        [merchantId, actorId, reservation.id, reason.trim(), JSON.stringify({ sessionId, inventoryVariantId, buyerId, quantity, permission: PERMISSION, inventoryVersion: Number(updated.rows[0].version) })]);

      const result = { outcome: 'reserved', reservation, inventoryVersion: Number(updated.rows[0].version), override: true };
      await client.query(`UPDATE idempotency_requests SET response_status=201,response_body=$3::jsonb
        WHERE merchant_id=$1 AND idempotency_key=$2`, [merchantId, idempotencyKey, JSON.stringify(result)]);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      if (error.code === '23505') throw new DomainError('CONFLICT', 'concurrent duplicate or ownership conflict');
      throw error;
    } finally { client.release(); }
  }
}

module.exports = { PgReservationOverrideService, FORCE_ALLOCATION_PERMISSION: PERMISSION };
