'use strict';
const { sha256Payload } = require('../security/webhook-signatures');

function extractProviderEventId(provider, payload, rawBody) {
  if (provider === 'paystack') {
    const candidate = payload?.data?.id ?? payload?.data?.reference;
    if (candidate != null && String(candidate).length <= 200) return `paystack:${String(candidate)}`;
  }
  if (provider === 'meta_whatsapp') {
    const messageId = payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.id;
    if (typeof messageId === 'string' && messageId.length <= 200) return `whatsapp:${messageId}`;
  }
  return `payload:${sha256Payload(rawBody)}`;
}

class PgWebhookInboxService {
  constructor({ pool }) {
    if (!pool) throw new TypeError('pool required');
    this.pool = pool;
  }

  async ingest({ endpointId, merchantId, provider, payload, rawBody }) {
    const payloadHash = sha256Payload(rawBody);
    const providerEventId = extractProviderEventId(provider, payload, rawBody);
    const eventType = typeof payload?.event === 'string'
      ? payload.event.slice(0, 200)
      : typeof payload?.object === 'string'
        ? payload.object.slice(0, 200)
        : 'unknown';

    const result = await this.pool.query(`INSERT INTO webhook_inbox
      (id,webhook_endpoint_id,merchant_id,provider,provider_event_id,event_type,
       payload_sha256,payload,status,signature_verified_at)
      VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7::jsonb,'received',now())
      ON CONFLICT (webhook_endpoint_id,provider_event_id) DO NOTHING
      RETURNING id`, [
        endpointId,
        merchantId,
        provider,
        providerEventId,
        eventType,
        payloadHash,
        JSON.stringify(payload),
      ]);

    return {
      accepted: true,
      deduplicated: result.rowCount === 0,
      inboxId: result.rows?.[0]?.id || null,
      providerEventId,
      payloadHash,
    };
  }
}

module.exports = { PgWebhookInboxService, extractProviderEventId };
