'use strict';

const HEADER_NAME = 'If-Inventory-Version';

class InventoryVersionError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'InventoryVersionError';
    this.code = code;
    this.status = status;
  }
}

function normalizeExpectedInventoryVersion(value) {
  if (typeof value === 'string') {
    if (!/^(0|[1-9]\d*)$/.test(value)) {
      throw new InventoryVersionError('INVALID_INVENTORY_VERSION', `${HEADER_NAME} must be a non-negative integer`, 400);
    }
    value = Number(value);
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InventoryVersionError('INVENTORY_VERSION_REQUIRED', `${HEADER_NAME} is required and must be a non-negative safe integer`, 428);
  }
  return value;
}

function assertInventoryVersionMatch(actualVersion, expectedVersion) {
  const expected = normalizeExpectedInventoryVersion(expectedVersion);
  const actual = Number(actualVersion);
  if (!Number.isSafeInteger(actual) || actual < 0) {
    throw new InventoryVersionError('INVALID_AUTHORITATIVE_INVENTORY_VERSION', 'authoritative inventory version is invalid', 503);
  }
  if (actual !== expected) {
    throw new InventoryVersionError('STALE_INVENTORY_VERSION', 'inventory changed after the client snapshot; refresh before retrying', 409);
  }
  return expected;
}

module.exports = {
  INVENTORY_VERSION_HEADER: HEADER_NAME,
  InventoryVersionError,
  normalizeExpectedInventoryVersion,
  assertInventoryVersionMatch,
};
