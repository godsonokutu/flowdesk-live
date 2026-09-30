'use strict';

class WebhookEndpointError extends Error {
  constructor(code, message, status = 404) {
    super(message);
    this.name = 'WebhookEndpointError';
    this.code = code;
    this.status = status;
  }
}

class PgWebhookEndpointService {
  constructor({ pool, secretResolver }) {
    if (!pool) throw new TypeError('pool required');
    if (!secretResolver || typeof secretResolver.resolve !== 'function') {
      throw new TypeError('secretResolver.resolve required');
    }
    this.pool = pool;
    this.secretResolver = secretResolver;
  }

  async resolve({ endpointKey, expectedProvider }) {
    if (typeof endpointKey !== 'string' || !/^[A-Za-z0-9_-]{24,96}$/.test(endpointKey)) {
      throw new WebhookEndpointError('WEBHOOK_ENDPOINT_NOT_FOUND', 'webhook endpoint not found');
    }
    const result = await this.pool.query(`SELECT
        id,merchant_id,provider,secret_ref,verify_token_ref,status
      FROM webhook_endpoints
      WHERE endpoint_key=$1
      LIMIT 1`, [endpointKey]);
    const row = result.rows?.[0];
    if (!row || row.status !== 'active' || row.provider !== expectedProvider) {
      throw new WebhookEndpointError('WEBHOOK_ENDPOINT_NOT_FOUND', 'webhook endpoint not found');
    }
    const secret = await this.secretResolver.resolve(row.secret_ref);
    if (!secret) throw new WebhookEndpointError('WEBHOOK_SECRET_UNAVAILABLE', 'webhook secret unavailable', 503);
    return {
      id: row.id,
      merchantId: row.merchant_id,
      provider: row.provider,
      secret,
      verifyTokenRef: row.verify_token_ref || null,
    };
  }
}

module.exports = { PgWebhookEndpointService, WebhookEndpointError };
