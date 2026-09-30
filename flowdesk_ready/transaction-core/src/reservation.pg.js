'use strict';
const crypto = require('node:crypto');

class DomainError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

const stableHash = (value) =>
  crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');

class PgReservationService {
  constructor({ pool }) {
    if (!pool) throw new TypeError('pool required');
    this.pool = pool;
  }

  async acceptBuyerIntent(input) {
    const {
      merchantId,
      sessionId,
      inventoryVariantId,
      buyerId,
      quantity = 1,
      idempotencyKey,
      providerEventId = null,
    } = input;

    if (!merchantId || !sessionId || !inventoryVariantId || !buyerId) {
      throw new DomainError('INVALID_INPUT', 'Required identifiers missing', 400);
    }
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new DomainError('INVALID_QUANTITY', 'quantity must be a positive integer', 400);
    }
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 16 || idempotencyKey.length > 200) {
      throw new DomainError('INVALID_IDEMPOTENCY_KEY', 'idempotency key must be 16-200 characters', 400);
    }

    const requestHash = stableHash({
      sessionId,
      inventoryVariantId,
      buyerId,
      quantity,
      providerEventId,
    });

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const idem = await client.query(`INSERT INTO idempotency_requests
        (merchant_id,idempotency_key,request_hash,operation,expires_at)
        VALUES ($1,$2,$3,'accept_buyer_intent',now()+interval '24 hours')
        ON CONFLICT (merchant_id,idempotency_key) DO NOTHING
        RETURNING request_hash,response_status,response_body`,
        [merchantId, idempotencyKey, requestHash]);

      if (idem.rowCount === 0) {
        const prior = (await client.query(`SELECT request_hash,response_status,response_body
          FROM idempotency_requests
          WHERE merchant_id=$1 AND idempotency_key=$2
          FOR UPDATE`, [merchantId, idempotencyKey])).rows[0];

        if (!prior) {
          throw new DomainError('IDEMPOTENCY_RACE', 'idempotency record disappeared', 503);
        }
        if (prior.request_hash !== requestHash) {
          throw new DomainError(
            'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD',
            'idempotency key already used for another request'
          );
        }
        if (prior.response_body) {
          await client.query('COMMIT');
          return prior.response_body;
        }
        throw new DomainError(
          'IDEMPOTENCY_REQUEST_IN_PROGRESS',
          'matching request is still in progress',
          409
        );
      }

      if (providerEventId) {
        const insertedEvent = await client.query(`INSERT INTO provider_events
          (id,merchant_id,provider,provider_event_id,event_type,payload_hash)
          VALUES (gen_random_uuid(),$1,'whatsapp',$2,'buyer_intent',$3)
          ON CONFLICT (merchant_id,provider,provider_event_id) DO NOTHING
          RETURNING id`,
          [merchantId, providerEventId, requestHash]);

        if (insertedEvent.rowCount === 0) {
          // Provider retries are payload-bound: the same provider event id may replay
          // the original delivery, but it may never be reused for a different intent.
          const priorEvent = (await client.query(`SELECT payload_hash
            FROM provider_events
            WHERE merchant_id=$1 AND provider='whatsapp' AND provider_event_id=$2
            FOR SHARE`,
            [merchantId, providerEventId])).rows[0];

          if (!priorEvent || priorEvent.payload_hash !== requestHash) {
            throw new DomainError(
              'PROVIDER_EVENT_REUSED_WITH_DIFFERENT_PAYLOAD',
              'provider event id already belongs to a different payload'
            );
          }

          // A valid retry acknowledges the original durable side effect instead of
          // manufacturing an error that tempts callers to mutate the provider event id.
          const existingReservation = (await client.query(`SELECT
              id,status,expires_at,quantity
            FROM reservations
            WHERE merchant_id=$1 AND provider_event_id=$2
            LIMIT 1`,
            [merchantId, providerEventId])).rows[0];

          let result;
          if (existingReservation) {
            result = { outcome: 'reserved', reservation: existingReservation, deduplicated: true };
          } else {
            const existingWaitlist = (await client.query(`SELECT
                id,status,position_seq,quantity
              FROM waitlist_entries
              WHERE merchant_id=$1 AND provider_event_id=$2
              LIMIT 1`,
              [merchantId, providerEventId])).rows[0];

            if (!existingWaitlist) {
              throw new DomainError(
                'PROVIDER_EVENT_STATE_MISSING',
                'provider event exists without reservation/waitlist side effect',
                503
              );
            }
            result = { outcome: 'waitlisted', waitlist: existingWaitlist, deduplicated: true };
          }

          await client.query(`UPDATE idempotency_requests
            SET response_status=200,response_body=$3::jsonb
            WHERE merchant_id=$1 AND idempotency_key=$2`,
            [merchantId, idempotencyKey, JSON.stringify(result)]);
          await client.query('COMMIT');
          return result;
        }
      }

      const session = (await client.query(`SELECT id,status,reservation_ttl_seconds
        FROM live_sessions
        WHERE id=$1 AND merchant_id=$2
        FOR SHARE`, [sessionId, merchantId])).rows[0];

      if (!session || session.status !== 'live') {
        throw new DomainError('SESSION_NOT_LIVE', 'LIVE session is not active');
      }

      // This is the hot-SKU serialization point. Every stock allocation and waitlist
      // position assignment for the variant happens while this row is locked.
      const inventory = (await client.query(`SELECT id,available_qty,reserved_qty,version
        FROM inventory_variants
        WHERE id=$1 AND merchant_id=$2
        FOR UPDATE`, [inventoryVariantId, merchantId])).rows[0];

      if (!inventory) {
        throw new DomainError('INVENTORY_NOT_FOUND', 'inventory variant not found', 404);
      }

      let result;
      if (Number(inventory.available_qty) >= quantity) {
        const reservation = (await client.query(`INSERT INTO reservations
          (id,merchant_id,live_session_id,inventory_variant_id,buyer_id,quantity,status,expires_at,provider_event_id)
          VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'active',now()+make_interval(secs=>$6),$7)
          RETURNING id,status,expires_at,quantity`,
          [
            merchantId,
            sessionId,
            inventoryVariantId,
            buyerId,
            quantity,
            session.reservation_ttl_seconds,
            providerEventId,
          ])).rows[0];

        const updated = await client.query(`UPDATE inventory_variants
          SET available_qty=available_qty-$1,
              reserved_qty=reserved_qty+$1,
              version=version+1
          WHERE id=$2 AND merchant_id=$3 AND available_qty >= $1
          RETURNING available_qty,reserved_qty,version`,
          [quantity, inventoryVariantId, merchantId]);

        if (updated.rowCount !== 1) {
          throw new DomainError(
            'INVENTORY_ACCOUNTING_CONFLICT',
            'reservation could not claim available inventory',
            503
          );
        }

        result = {
          outcome: 'reserved',
          reservation,
          inventoryVersion: Number(updated.rows[0].version),
        };
      } else {
        // Do NOT add FOR UPDATE to this aggregate. PostgreSQL locking clauses do
        // not apply to aggregate output rows. The inventory row lock above is what
        // serializes MAX(position_seq)+1 for this SKU.
        const position = (await client.query(`SELECT COALESCE(MAX(position_seq),0)+1 AS next_position
          FROM waitlist_entries
          WHERE live_session_id=$1 AND inventory_variant_id=$2`,
          [sessionId, inventoryVariantId])).rows[0].next_position;

        const waitlist = (await client.query(`INSERT INTO waitlist_entries
          (id,merchant_id,live_session_id,inventory_variant_id,buyer_id,quantity,status,position_seq,provider_event_id)
          VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'waiting',$6,$7)
          RETURNING id,status,position_seq,quantity`,
          [
            merchantId,
            sessionId,
            inventoryVariantId,
            buyerId,
            quantity,
            position,
            providerEventId,
          ])).rows[0];

        result = {
          outcome: 'waitlisted',
          waitlist,
          inventoryVersion: Number(inventory.version),
        };
      }

      if (providerEventId) {
        await client.query(`UPDATE provider_events
          SET processed_at=now()
          WHERE merchant_id=$1 AND provider='whatsapp' AND provider_event_id=$2`,
          [merchantId, providerEventId]);
      }

      await client.query(`UPDATE idempotency_requests
        SET response_status=201,response_body=$3::jsonb
        WHERE merchant_id=$1 AND idempotency_key=$2`,
        [merchantId, idempotencyKey, JSON.stringify(result)]);

      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      if (error.code === '23505') {
        throw new DomainError('CONFLICT', 'Concurrent duplicate or ownership conflict');
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = {
  PgReservationService,
  DomainError,
  stableHash,
  canonicalize,
};
