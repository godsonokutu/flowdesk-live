'use strict';
const { normalizeExpectedInventoryVersion, INVENTORY_VERSION_HEADER } = require('./inventory.version-precondition');

/**
 * HTTP-framework-neutral extractor. Node/Fetch/framework adapters may pass a
 * plain object, Headers-like object, or normalized request headers.
 */
function readHeader(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name);
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === target) return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

function requireInventoryVersionHeader(headers) {
  return normalizeExpectedInventoryVersion(readHeader(headers, INVENTORY_VERSION_HEADER));
}

module.exports = { readHeader, requireInventoryVersionHeader };
