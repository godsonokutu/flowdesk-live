'use strict';

class AuthorizationError extends Error {
  constructor(code, message, status = 403) {
    super(message);
    this.name = 'AuthorizationError';
    this.code = code;
    this.status = status;
  }
}

class PgAuthorizationService {
  constructor({ pool }) {
    if (!pool) throw new TypeError('pool required');
    this.pool = pool;
  }

  async assertMembership({ merchantId, actorId }) {
    if (!merchantId || !actorId) throw new AuthorizationError('AUTHZ_CONTEXT_INVALID', 'authorization context missing');
    const result = await this.pool.query(`SELECT status
      FROM merchant_memberships
      WHERE merchant_id=$1 AND actor_id=$2`, [merchantId, actorId]);
    const row = result.rows?.[0];
    if (!row || row.status !== 'active') {
      throw new AuthorizationError('MERCHANT_MEMBERSHIP_REQUIRED', 'active merchant membership required');
    }
    return true;
  }

  async assertPermission({ merchantId, actorId, permission }) {
    if (!permission || typeof permission !== 'string') {
      throw new AuthorizationError('PERMISSION_INVALID', 'permission required', 500);
    }
    const result = await this.pool.query(`SELECT 1
      FROM merchant_memberships m
      JOIN merchant_permissions p
        ON p.merchant_id=m.merchant_id AND p.actor_id=m.actor_id
      WHERE m.merchant_id=$1
        AND m.actor_id=$2
        AND m.status='active'
        AND p.permission=$3
      LIMIT 1`, [merchantId, actorId, permission]);
    if (result.rowCount !== 1) {
      throw new AuthorizationError('PERMISSION_REQUIRED', `permission ${permission} required`);
    }
    return true;
  }
}

module.exports = { PgAuthorizationService, AuthorizationError };
