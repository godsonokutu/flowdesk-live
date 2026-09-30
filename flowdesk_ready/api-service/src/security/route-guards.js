'use strict';
const { normalizeAuthClaims, assertFreshStepUp } = require('./auth-context');

function createRouteGuards({ authorization, clock = () => new Date() }) {
  if (!authorization) throw new TypeError('authorization service required');

  async function authenticate(request) {
    await request.jwtVerify();
    request.auth = normalizeAuthClaims(request.user);
  }

  function requireMembership() {
    return async function membershipGuard(request) {
      await authorization.assertMembership({
        merchantId: request.auth.merchantId,
        actorId: request.auth.actorId,
      });
    };
  }

  function requirePermission(permission) {
    return async function permissionGuard(request) {
      await authorization.assertPermission({
        merchantId: request.auth.merchantId,
        actorId: request.auth.actorId,
        permission,
      });
    };
  }

  function requireStepUp(maxAgeMs = 10 * 60 * 1000) {
    return async function stepUpGuard(request) {
      assertFreshStepUp(request.auth, { maxAgeMs, clock });
    };
  }

  return { authenticate, requireMembership, requirePermission, requireStepUp };
}

module.exports = { createRouteGuards };
