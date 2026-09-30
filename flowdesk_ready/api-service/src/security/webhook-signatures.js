'use strict';
const crypto = require('node:crypto');

class WebhookAuthError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WebhookAuthError';
    this.code = code;
    this.status = 401;
  }
}

function toBuffer(rawBody) {
  if (Buffer.isBuffer(rawBody)) return rawBody;
  if (typeof rawBody === 'string') return Buffer.from(rawBody, 'utf8');
  throw new WebhookAuthError('WEBHOOK_RAW_BODY_REQUIRED', 'raw webhook body required');
}

function safeEqualHex(expectedHex, suppliedHex) {
  if (typeof suppliedHex !== 'string' || !/^[0-9a-f]+$/i.test(suppliedHex)) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const supplied = Buffer.from(suppliedHex, 'hex');
  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}

function verifyPaystackSignature({ rawBody, signature, secret }) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new WebhookAuthError('WEBHOOK_SECRET_UNAVAILABLE', 'payment webhook secret unavailable');
  }
  const expected = crypto.createHmac('sha512', secret).update(toBuffer(rawBody)).digest('hex');
  if (!safeEqualHex(expected, signature)) {
    throw new WebhookAuthError('WEBHOOK_SIGNATURE_INVALID', 'payment webhook signature invalid');
  }
  return true;
}

function verifyMetaSignature({ rawBody, signature, secret }) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new WebhookAuthError('WEBHOOK_SECRET_UNAVAILABLE', 'Meta webhook app secret unavailable');
  }
  if (typeof signature !== 'string' || !signature.startsWith('sha256=')) {
    throw new WebhookAuthError('WEBHOOK_SIGNATURE_INVALID', 'Meta webhook signature invalid');
  }
  const expected = crypto.createHmac('sha256', secret).update(toBuffer(rawBody)).digest('hex');
  if (!safeEqualHex(expected, signature.slice('sha256='.length))) {
    throw new WebhookAuthError('WEBHOOK_SIGNATURE_INVALID', 'Meta webhook signature invalid');
  }
  return true;
}

function sha256Payload(rawBody) {
  return crypto.createHash('sha256').update(toBuffer(rawBody)).digest('hex');
}

module.exports = {
  WebhookAuthError,
  verifyPaystackSignature,
  verifyMetaSignature,
  sha256Payload,
  safeEqualHex,
};
