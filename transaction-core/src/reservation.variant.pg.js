'use strict';

const { DomainError, stableHash } = require('./reservation.pg');
const { enqueueInventoryAvailable } = require('./lifecycle.outbox.pg');

const ACTOR_TYPES = new Set(['buyer', 'operator', 'system']);

class PgReservationVariantService {
  constructor({ pool }) {
    if (!pool) throw new TypeError('pool required');
    this.pool = pool;
  }

  async switchVariant(input) {
    const {
      merchantId,
      reservationId,
      destinationInventoryVariantId,
      idempotencyKey,
      actorType = 'buyer',
      actorId,
      reason = 'Reservation variant change requested',
    } = input;

    if (!merchantId || !reservationId || !destinationInventoryVariantId || !actorId) {
      throw new DomainError('INVALID_INPUT', 'required variant-switch identifiers missing', 400);
    }
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 16 || idempotencyKey.length > 200) {
      throw new DomainError('INVALID_IDEMPOTENCY_KEY', 'idempotency key must be 16-200 characters', 400);
    }
    if (!ACTOR_TYPES.has(actorType)) {
      throw new DomainError('INVALID_ACTOR_TYPE', 'actorType must be buyer, operator, or system', 400);
    }
    if (typeof reason !== 'string' || reason.trim().length < 8 || reason.trim().length > 500) {
      throw new DomainError('INVALID_SWITCH_REASON', 'variant-switch reason must be 8-500 characters', 400);
    }

    const requestHash = stableHash({
      reservationId,
      destinationInventoryVariantId,
      actorType,
      actorId,
      reason: reason.trim(),
    });

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const idem = await client.query(`INSERT INTO idempotency_requests
        (merchant_id,idempotency_key,request_hash,operation,expires_at)
        VALUES ($1,$2,$3,'switch_reservation_variant',now()+interval '24 hours')
        ON CONFLICT (merchant_id,idempotency_key) DO NOTHING
        RETURNING request_hash,response_body`, [merchantId, idempotencyKey, requestHash]);

      if (idem.rowCount === 0) {
        const prior = (await client.query(`SELECT request_hash,response_body
          FROM idempotency_requests
          WHERE merchant_id=$1 AND idempotency_key=$2
          FOR UPDATE`, [merchantId, idempotencyKey])).rows[0];
        if (!prior) throw new DomainError('IDEMPOTENCY_RACE', 'idempotency record disappeared', 503);
        if (prior.request_hash !== requestHash) {
          throw new DomainError('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD', 'idempotency key already used for another request');
        }
        if (prior.response_body) {
          await client.query('COMMIT');
          return { ...prior.response_body, deduplicated: true };
        }
        throw new DomainError('IDEMPOTENCY_REQUEST_IN_PROGRESS', 'matching request is still in progress');
      }

      const reservation = (await client.query(`SELECT
          id,live_session_id,inventory_variant_id,buyer_id,quantity,status
        FROM reservations
        WHERE id=$1 AND merchant_id=$2
        FOR UPDATE`, [reservationId, merchantId])).rows[0];

      if (!reservation) throw new DomainError('RESERVATION_NOT_FOUND', 'reservation not found', 404);
      if (!['active', 'payment_pending'].includes(reservation.status)) {
        throw new DomainError('RESERVATION_ALREADY_TERMINAL', `cannot switch variant from ${reservation.status}`);
      }

      const sourceInventoryVariantId = reservation.inventory_variant_id;
      if (sourceInventoryVariantId === destinationInventoryVariantId) {
        const result = {
          outcome: 'no_change',
          reservationId,
          inventoryVariantId: sourceInventoryVariantId,
          quantity: Number(reservation.quantity),
        };
        await client.query(`UPDATE idempotency_requests SET response_status=200,response_body=$3::jsonb
          WHERE merchant_id=$1 AND idempotency_key=$2`, [merchantId, idempotencyKey, JSON.stringify(result)]);
        await client.query('COMMIT');
        return result;
      }

      const session = (await client.query(`SELECT id,status FROM live_sessions
        WHERE id=$1 AND merchant_id=$2 FOR SHARE`, [reservation.live_session_id, merchantId])).rows[0];
      if (!session || session.status !== 'live') {
        throw new DomainError('SESSION_NOT_LIVE', 'LIVE session is not active');
      }

      // Deterministic row-lock order prevents A->B and B->A switches from deadlocking.
      const inventoryRows = (await client.query(`SELECT id,available_qty,reserved_qty,version
        FROM inventory_variants
        WHERE merchant_id=$1 AND id = ANY($2::uuid[])
        ORDER BY id
        FOR UPDATE`, [merchantId, [sourceInventoryVariantId, destinationInventoryVariantId]])).rows;

      const byId = new Map(inventoryRows.map((row) => [row.id, row]));
      const source = byId.get(sourceInventoryVariantId);
      const destination = byId.get(destinationInventoryVariantId);
      if (!source) throw new DomainError('SOURCE_INVENTORY_NOT_FOUND', 'source inventory variant not found', 404);
      if (!destination) throw new DomainError('DESTINATION_INVENTORY_NOT_FOUND', 'destination inventory variant not found', 404);

      const quantity = Number(reservation.quantity);
      if (Number(source.reserved_qty) < quantity) {
        throw new DomainError('INVENTORY_ACCOUNTING_CONFLICT', 'source variant does not hold the reservation quantity', 503);
      }
      if (Number(destination.available_qty) < quantity) {
        throw new DomainError('DESTINATION_VARIANT_UNAVAILABLE', 'destination variant does not have enough authoritative stock');
      }

      const sourceUpdate = await client.query(`UPDATE inventory_variants SET
          available_qty=available_qty+$1,
          reserved_qty=reserved_qty-$1,
          version=version+1
        WHERE id=$2 AND merchant_id=$3 AND reserved_qty >= $1
        RETURNING version`, [quantity, sourceInventoryVariantId, merchantId]);
      if (sourceUpdate.rowCount !== 1) {
        throw new DomainError('INVENTORY_ACCOUNTING_CONFLICT', 'could not release source reserved inventory', 503);
      }

      const destinationUpdate = await client.query(`UPDATE inventory_variants SET
          available_qty=available_qty-$1,
          reserved_qty=reserved_qty+$1,
          version=version+1
        WHERE id=$2 AND merchant_id=$3 AND available_qty >= $1
        RETURNING version`, [quantity, destinationInventoryVariantId, merchantId]);
      if (destinationUpdate.rowCount !== 1) {
        throw new DomainError('DESTINATION_VARIANT_UNAVAILABLE', 'destination stock changed before atomic claim');
      }

      const updatedReservation = (await client.query(`UPDATE reservations SET
          inventory_variant_id=$1,
          updated_at=now()
        WHERE id=$2 AND merchant_id=$3
        RETURNING id,live_session_id,inventory_variant_id,buyer_id,quantity,status,expires_at`,
        [destinationInventoryVariantId, reservationId, merchantId])).rows[0];

      const audit = (await client.query(`INSERT INTO audit_events
        (id,merchant_id,actor_type,actor_id,action,entity_type,entity_id,reason,metadata)
        VALUES (gen_random_uuid(),$1,$2,$3,'reservation.variant_switched','reservation',$4,$5,$6::jsonb)
        RETURNING id`, [
          merchantId,
          actorType,
          actorId,
          reservationId,
          reason.trim(),
          JSON.stringify({
            fromInventoryVariantId: sourceInventoryVariantId,
            toInventoryVariantId: destinationInventoryVariantId,
            quantity,
            sourceInventoryVersion: Number(sourceUpdate.rows[0].version),
            destinationInventoryVersion: Number(destinationUpdate.rows[0].version),
          }),
        ])).rows[0];

      const outbox = await enqueueInventoryAvailable(client, {
        merchantId,
        sessionId: reservation.live_session_id,
        inventoryVariantId: sourceInventoryVariantId,
        sourceType: 'variant_switch',
        sourceId: audit.id,
        reason: 'variant_switch_released_source_inventory',
      });

      const result = {
        outcome: 'switched',
        reservation: updatedReservation,
        fromInventoryVariantId: sourceInventoryVariantId,
        toInventoryVariantId: destinationInventoryVariantId,
        quantity,
        sourceInventoryVersion: Number(sourceUpdate.rows[0].version),
        destinationInventoryVersion: Number(destinationUpdate.rows[0].version),
        promotionQueued: outbox.enqueued,
        outboxId: outbox.outboxId,
      };

      await client.query(`UPDATE idempotency_requests SET response_status=200,response_body=$3::jsonb
        WHERE merchant_id=$1 AND idempotency_key=$2`, [merchantId, idempotencyKey, JSON.stringify(result)]);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      if (error.code === '23505') {
        throw new DomainError('DESTINATION_OWNERSHIP_CONFLICT', 'buyer already owns an active claim on the destination variant');
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = { PgReservationVariantService };
