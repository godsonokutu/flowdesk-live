'use strict';

class AuthError extends Error {
  constructor(code, message, status = 401) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.status = status;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeAuthClaims(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new AuthError('AUTH_TOKEN_INVALID', 'verified JWT payload missing');
  }
  const actorId = typeof payload.sub === 'string' ? payload.sub.trim() : '';
  const merchantId = typeof payload.merchant_id === 'string' ? payload.merchant_id.trim() : '';
  if (!actorId) throw new AuthError('AUTH_SUBJECT_REQUIRED', 'JWT subject is required');
  if (!UUID_RE.test(merchantId)) {
    throw new AuthError('AUTH_MERCHANT_REQUIRED', 'JWT merchant_id must be a UUID', 403);
  }

  const tokenPermissions = Array.isArray(payload.permissions)
    ? [...new Set(payload.permissions.filter((p) => typeof p === 'string' && p.length <= 128))]
    : [];

  let stepUpVerifiedAt = null;
  if (payload.step_up_at != null) {
    if (typeof payload.step_up_at === 'number' && Number.isFinite(payload.step_up_at)) {
      stepUpVerifiedAt = new Date(payload.step_up_at * 1000);
    } else {
      const parsed = new Date(payload.step_up_at);
      if (!Number.isNaN(parsed.getTime())) stepUpVerifiedAt = parsed;
    }
  }

  return Object.freeze({
    actorId,
    merchantId,
    tokenPermissions,
    stepUpVerifiedAt,
    tokenId: typeof payload.jti === 'string' ? payload.jti : null,
  });
}

function assertFreshStepUp(auth, { maxAgeMs = 10 * 60 * 1000, clock = () => new Date() } = {}) {
  if (!auth?.stepUpVerifiedAt) {
    throw new AuthError('STEP_UP_REQUIRED', 'fresh step-up verification required', 403);
  }
  const now = clock();
  const verifiedAt = new Date(auth.stepUpVerifiedAt);
  if (Number.isNaN(verifiedAt.getTime()) || verifiedAt > now || now - verifiedAt > maxAgeMs) {
    throw new AuthError('STEP_UP_REQUIRED', 'fresh step-up verification required', 403);
  }
  return verifiedAt;
}

module.exports = { AuthError, normalizeAuthClaims, assertFreshStepUp, UUID_RE };
