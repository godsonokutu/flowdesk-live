'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {normalizeAuthClaims,assertFreshStepUp}=require('../src/security/auth-context');
const {verifyPaystackSignature,verifyMetaSignature,sha256Payload}=require('../src/security/webhook-signatures');
const {requireIdempotencyKey,requireInventoryVersion}=require('../src/security/request-guards');
const {toProblem,SAFE_SERVER_MESSAGE}=require('../src/http/problem');

const merchant='11111111-1111-4111-8111-111111111111';

test('verified JWT claims normalize tenant and actor without trusting body tenant',()=>{
 const auth=normalizeAuthClaims({sub:'operator-1',merchant_id:merchant,permissions:['x','x'],jti:'t1'});
 assert.equal(auth.actorId,'operator-1');
 assert.equal(auth.merchantId,merchant);
 assert.deepEqual(auth.tokenPermissions,['x']);
});
test('JWT without merchant UUID fails closed',()=>assert.throws(
 ()=>normalizeAuthClaims({sub:'operator-1',merchant_id:'merchant-name'}),
 e=>e.code==='AUTH_MERCHANT_REQUIRED'&&e.status===403
));
test('step-up accepts fresh signed claim',()=>{
 const now=new Date('2026-09-30T03:20:00Z');
 const auth=normalizeAuthClaims({sub:'o',merchant_id:merchant,step_up_at:'2026-09-30T03:15:00Z'});
 assert.equal(assertFreshStepUp(auth,{clock:()=>now}).toISOString(),'2026-09-30T03:15:00.000Z');
});
test('step-up rejects stale claim',()=>{
 const now=new Date('2026-09-30T03:20:00Z');
 const auth=normalizeAuthClaims({sub:'o',merchant_id:merchant,step_up_at:'2026-09-30T03:00:00Z'});
 assert.throws(()=>assertFreshStepUp(auth,{clock:()=>now}),e=>e.code==='STEP_UP_REQUIRED');
});
test('Paystack verifier validates HMAC SHA512 over exact raw bytes',()=>{
 const raw=Buffer.from('{"event":"charge.success","data":{"id":7}}');
 const secret='sk_test_1234567890abcdef';
 const signature=crypto.createHmac('sha512',secret).update(raw).digest('hex');
 assert.equal(verifyPaystackSignature({rawBody:raw,signature,secret}),true);
});
test('Paystack verifier rejects changed payload with old signature',()=>{
 const secret='sk_test_1234567890abcdef';
 const signature=crypto.createHmac('sha512',secret).update(Buffer.from('{"a":1}')).digest('hex');
 assert.throws(
  ()=>verifyPaystackSignature({rawBody:Buffer.from('{"a":2}'),signature,secret}),
  e=>e.code==='WEBHOOK_SIGNATURE_INVALID'
 );
});
test('Meta verifier validates sha256= HMAC envelope',()=>{
 const raw=Buffer.from('{"object":"whatsapp_business_account"}');
 const secret='meta_app_secret_1234567890';
 const digest=crypto.createHmac('sha256',secret).update(raw).digest('hex');
 assert.equal(verifyMetaSignature({rawBody:raw,signature:`sha256=${digest}`,secret}),true);
});
test('payload hashing is deterministic over exact bytes',()=>{
 assert.equal(sha256Payload(Buffer.from('abc')),crypto.createHash('sha256').update('abc').digest('hex'));
});
test('idempotency guard accepts 16-200 chars and rejects CRLF',()=>{
 assert.equal(requireIdempotencyKey({'idempotency-key':'0123456789abcdef'}),'0123456789abcdef');
 assert.throws(()=>requireIdempotencyKey({'idempotency-key':'0123456789abcdef\r\nx:1'}),e=>e.code==='IDEMPOTENCY_KEY_INVALID');
});
test('inventory version missing maps to 428 semantics',()=>{
 assert.throws(()=>requireInventoryVersion({}),e=>e.status===428&&e.code==='INVENTORY_VERSION_REQUIRED');
});
test('inventory version rejects non-canonical and unsafe values',()=>{
 assert.throws(()=>requireInventoryVersion({'if-inventory-version':'01'}),e=>e.code==='INVENTORY_VERSION_INVALID');
 assert.throws(()=>requireInventoryVersion({'if-inventory-version':'9999999999999999999'}),e=>e.code==='INVENTORY_VERSION_INVALID');
});
test('error mapper never leaks 5xx internal message',()=>{
 const p=toProblem(Object.assign(new Error('password=db-secret'),{code:'DB_FAILURE',status:503}),'req-1');
 assert.equal(p.detail,SAFE_SERVER_MESSAGE);
 assert.equal(p.request_id,'req-1');
 assert.equal(p.code,'DB_FAILURE');
});
test('error mapper preserves safe 4xx domain detail',()=>{
 const p=toProblem(Object.assign(new Error('permission required'),{code:'PERMISSION_REQUIRED',status:403}),'req-2');
 assert.equal(p.detail,'permission required');
 assert.equal(p.status,403);
});
