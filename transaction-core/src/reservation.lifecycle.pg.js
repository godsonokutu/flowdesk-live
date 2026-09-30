'use strict';

const { enqueueInventoryAvailable } = require('./lifecycle.outbox.pg');

class DomainError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

class PgReservationLifecycleService {
  constructor({ pool, clock = () => new Date() }) {
    if (!pool) throw new TypeError('pool required');
    this.pool = pool;
    this.clock = clock;
  }

  async settlePayment({
    merchantId,
    reservationId,
    provider,
    providerTransactionId,
    amountMinor,
    currency,
  }) {
    if (!merchantId || !reservationId || !provider || !providerTransactionId) {
      throw new DomainError('INVALID_INPUT', 'Required identifiers missing', 400);
    }
    if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
      throw new DomainError('INVALID_AMOUNT', 'amountMinor must be a non-negative safe integer', 400);
    }
    if (!/^[A-Z]{3}$/.test(currency || '')) {
      throw new DomainError('INVALID_CURRENCY', 'currency must be ISO-4217 alpha-3', 400);
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const inserted = await client.query(`INSERT INTO payment_events
        (id,merchant_id,provider,provider_transaction_id,reservation_id,amount_minor,currency,status)
        VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,'received')
        ON CONFLICT (merchant_id,provider,provider_transaction_id) DO NOTHING
        RETURNING id`,
        [merchantId, provider, providerTransactionId, reservationId, amountMinor, currency]);

      if (inserted.rowCount === 0) {
        const prior = (await client.query(`SELECT
            reservation_id,amount_minor,currency,status,result_body
          FROM payment_events
          WHERE merchant_id=$1 AND provider=$2 AND provider_transaction_id=$3
          FOR UPDATE`,
          [merchantId, provider, providerTransactionId])).rows[0];

        if (!prior) {
          throw new DomainError('PAYMENT_EVENT_RACE', 'payment event disappeared', 503);
        }

        if (
          prior.reservation_id !== reservationId ||
          String(prior.amount_minor) !== String(amountMinor) ||
          prior.currency !== currency
        ) {
          throw new DomainError(
            'PAYMENT_EVENT_REUSED_WITH_DIFFERENT_PAYLOAD',
            'provider transaction id already belongs to a different payment payload'
          );
        }

        if (!prior.result_body) {
          throw new DomainError(
            'PAYMENT_EVENT_INCOMPLETE',
            'payment event exists without a durable result',
            503
          );
        }

        await client.query('COMMIT');
        return prior.result_body;
      }

      const reservation = (await client.query(`SELECT
          id,live_session_id,inventory_variant_id,quantity,status,expires_at
        FROM reservations
        WHERE id=$1 AND merchant_id=$2
        FOR UPDATE`, [reservationId, merchantId])).rows[0];

      if (!reservation) {
        throw new DomainError('RESERVATION_NOT_FOUND', 'reservation not found', 404);
      }

      let result;

      if (reservation.status === 'paid') {
        result = { outcome: 'already_paid', reservationId };
      } else if (reservation.status === 'reconciliation_required') {
        result = { outcome: 'reconciliation_required', reservationId, inventoryReleased: false };
      } else if (['expired', 'cancelled'].includes(reservation.status)) {
        // The hold was already released by the terminal transition. Record the late
        // money state without touching inventory now owned by somebody else.
        await client.query(`UPDATE reservations
          SET status='reconciliation_required',updated_at=now()
          WHERE id=$1`, [reservationId]);
        result = { outcome: 'reconciliation_required', reservationId, inventoryReleased: false };
      } else if (new Date(reservation.expires_at) <= this.clock()) {
        await client.query(`SELECT id
          FROM inventory_variants
          WHERE id=$1 AND merchant_id=$2
          FOR UPDATE`, [reservation.inventory_variant_id, merchantId]);

        const released = await client.query(`UPDATE inventory_variants
          SET available_qty=available_qty+$1,
              reserved_qty=reserved_qty-$1,
              version=version+1
          WHERE id=$2 AND merchant_id=$3 AND reserved_qty >= $1`,
          [reservation.quantity, reservation.inventory_variant_id, merchantId]);

        if (released.rowCount !== 1) {
          throw new DomainError(
            'INVENTORY_ACCOUNTING_CONFLICT',
            'could not release expired reservation inventory',
            503
          );
        }

        await client.query(`UPDATE reservations
          SET status='reconciliation_required',updated_at=now()
          WHERE id=$1`, [reservationId]);

        const queued = await enqueueInventoryAvailable(client, {
          merchantId,
          sessionId: reservation.live_session_id,
          inventoryVariantId: reservation.inventory_variant_id,
          sourceType: 'late_payment_expiry',
          sourceId: reservation.id,
          reason: 'late_payment_after_server_ttl',
        });

        result = {
          outcome: 'reconciliation_required',
          reservationId,
          inventoryReleased: true,
          promotionQueued: queued.enqueued || Boolean(queued.outboxId),
          outboxId: queued.outboxId,
        };
      } else if (['active', 'payment_pending'].includes(reservation.status)) {
        await client.query(`SELECT id
          FROM inventory_variants
          WHERE id=$1 AND merchant_id=$2
          FOR UPDATE`, [reservation.inventory_variant_id, merchantId]);

        const moved = await client.query(`UPDATE inventory_variants
          SET reserved_qty=reserved_qty-$1,
              sold_qty=sold_qty+$1,
              version=version+1
          WHERE id=$2 AND merchant_id=$3 AND reserved_qty >= $1`,
          [reservation.quantity, reservation.inventory_variant_id, merchantId]);

        if (moved.rowCount !== 1) {
          throw new DomainError(
            'INVENTORY_ACCOUNTING_CONFLICT',
            'could not convert reserved stock to sold',
            503
          );
        }

        await client.query(`UPDATE reservations
          SET status='paid',updated_at=now()
          WHERE id=$1`, [reservationId]);

        result = { outcome: 'paid', reservationId };
      } else {
        throw new DomainError(
          'INVALID_RESERVATION_STATE',
          `cannot settle payment from ${reservation.status}`
        );
      }

      await client.query(`UPDATE payment_events
        SET status='processed',processed_at=now(),result_body=$2::jsonb
        WHERE id=$1`,
        [inserted.rows[0].id, JSON.stringify(result)]);

      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  async expireReservation({ merchantId, reservationId }) {
    return this.#releaseReservation({
      merchantId,
      reservationId,
      nextStatus: 'expired',
      sourceType: 'reservation_expiry',
      reason: 'server_ttl_expired',
      requireExpired: true,
    });
  }

  async cancelReservation({ merchantId, reservationId }) {
    return this.#releaseReservation({
      merchantId,
      reservationId,
      nextStatus: 'cancelled',
      sourceType: 'reservation_cancel',
      reason: 'reservation_cancelled',
      requireExpired: false,
    });
  }

  async #releaseReservation({
    merchantId,
    reservationId,
    nextStatus,
    sourceType,
    reason,
    requireExpired,
  }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const reservation = (await client.query(`SELECT
          id,live_session_id,inventory_variant_id,quantity,status,expires_at
        FROM reservations
        WHERE id=$1 AND merchant_id=$2
        FOR UPDATE`, [reservationId, merchantId])).rows[0];

      if (!reservation) {
        throw new DomainError('RESERVATION_NOT_FOUND', 'reservation not found', 404);
      }

      if (!['active', 'payment_pending'].includes(reservation.status)) {
        await client.query('COMMIT');
        return {
          outcome: 'no_change',
          reservationId,
          status: reservation.status,
          promotionQueued: false,
        };
      }

      if (requireExpired && new Date(reservation.expires_at) > this.clock()) {
        await client.query('COMMIT');
        return {
          outcome: 'no_change',
          reservationId,
          status: reservation.status,
          promotionQueued: false,
        };
      }

      await client.query(`SELECT id
        FROM inventory_variants
        WHERE id=$1 AND merchant_id=$2
        FOR UPDATE`, [reservation.inventory_variant_id, merchantId]);

      const released = await client.query(`UPDATE inventory_variants
        SET available_qty=available_qty+$1,
            reserved_qty=reserved_qty-$1,
            version=version+1
        WHERE id=$2 AND merchant_id=$3 AND reserved_qty >= $1`,
        [reservation.quantity, reservation.inventory_variant_id, merchantId]);

      if (released.rowCount !== 1) {
        throw new DomainError(
          'INVENTORY_ACCOUNTING_CONFLICT',
          'could not release reservation inventory',
          503
        );
      }

      await client.query(`UPDATE reservations
        SET status=$2,updated_at=now()
        WHERE id=$1`, [reservationId, nextStatus]);

      const queued = await enqueueInventoryAvailable(client, {
        merchantId,
        sessionId: reservation.live_session_id,
        inventoryVariantId: reservation.inventory_variant_id,
        sourceType,
        sourceId: reservation.id,
        reason,
      });

      await client.query('COMMIT');

      return {
        outcome: nextStatus,
        reservationId,
        promotionQueued: queued.enqueued || Boolean(queued.outboxId),
        outboxId: queued.outboxId,
      };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = { PgReservationLifecycleService, DomainError };
