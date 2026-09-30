'use strict';

class RequestGuardError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'RequestGuardError';
    this.code = code;
    this.status = status;
  }
}

function headerValue(headers, name) {
  const value = headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function requireIdempotencyKey(headers) {
  const value = headerValue(headers, 'idempotency-key');
  if (typeof value !== 'string' || value.length < 16 || value.length > 200) {
    throw new RequestGuardError('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key must be 16-200 characters', 400);
  }
  if (/[\r\n]/.test(value)) throw new RequestGuardError('IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key contains invalid characters');
  return value;
}

function requireInventoryVersion(headers) {
  const raw = headerValue(headers, 'if-inventory-version');
  if (raw == null || raw === '') {
    throw new RequestGuardError('INVENTORY_VERSION_REQUIRED', 'If-Inventory-Version header is required', 428);
  }
  if (!/^(0|[1-9][0-9]{0,18})$/.test(String(raw))) {
    throw new RequestGuardError('INVENTORY_VERSION_INVALID', 'If-Inventory-Version must be a non-negative integer');
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new RequestGuardError('INVENTORY_VERSION_INVALID', 'If-Inventory-Version exceeds safe integer range');
  }
  return value;
}

module.exports = { RequestGuardError, requireIdempotencyKey, requireInventoryVersion, headerValue };
