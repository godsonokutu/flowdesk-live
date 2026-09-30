'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {registerTransactionRoutes}=require('../src/routes/transaction.routes');
const {registerOperationsRoutes}=require('../src/routes/operations.routes');
const {registerWebhookRoutes}=require('../src/routes/webhook.routes');

function fakeApp(){const routes=[];return {routes,route(def){routes.push(def)}}}
function named(name){const f=async()=>{};Object.defineProperty(f,'name',{value:name});return f}
const guards={
 authenticate:named('authenticate'),
 requireMembership:()=>named('membership'),
 requirePermission:(p)=>named(`permission_${p}`),
 requireStepUp:()=>named('stepup'),
};
function reply(){return {status:null,payload:null,code(n){this.status=n;return this},send(v){this.payload=v;return v}}}

test('transaction edge registers six concrete mutation routes',()=>{
 const app=fakeApp();
 registerTransactionRoutes(app,{services:{},guards});
 assert.equal(app.routes.length,6);
 assert.deepEqual(app.routes.map(r=>r.url),[
  '/v1/live-sessions/:sessionId/buyer-intents',
  '/v1/reservations/:reservationId/cancel',
  '/v1/reservations/:reservationId/switch-variant',
  '/v1/operator-overrides/force-allocation',
  '/v1/live-sessions/:sessionId/shutdown',
  '/v1/live-sessions/:sessionId/shutdown/finalize',
 ]);
});
test('force allocation requires auth, DB permission and fresh step-up',()=>{
 const app=fakeApp();registerTransactionRoutes(app,{services:{},guards});
 const r=app.routes.find(x=>x.url==='/v1/operator-overrides/force-allocation');
 assert.equal(r.preHandler.length,3);
 assert.equal(r.preHandler[0].name,'authenticate');
 assert.equal(r.preHandler[1].name,'permission_reservation.force_allocate');
 assert.equal(r.preHandler[2].name,'stepup');
 assert.deepEqual(r.schema.headers.required,['idempotency-key','if-inventory-version']);
});
test('shutdown requires live_session.end plus step-up at cut-over',()=>{
 const app=fakeApp();registerTransactionRoutes(app,{services:{},guards});
 const r=app.routes.find(x=>x.url.endsWith('/:sessionId/shutdown'));
 assert.equal(r.preHandler[1].name,'permission_live_session.end');
 assert.equal(r.preHandler[2].name,'stepup');
});
test('buyer intent derives merchant exclusively from verified auth context',async()=>{
 const app=fakeApp();let input;
 registerTransactionRoutes(app,{guards,services:{
  reservation:{acceptBuyerIntent:async(x)=>{input=x;return {outcome:'reserved'}}},
  lifecycle:{},variant:{},override:{},shutdown:{}
 }});
 const r=app.routes.find(x=>x.url.endsWith('/buyer-intents'));
 const rep=reply();
 await r.handler({
  auth:{merchantId:'trusted-merchant',actorId:'a'},
  params:{sessionId:'s'},
  body:{inventory_variant_id:'sku',buyer_id:'buyer',merchant_id:'attacker-merchant'},
  headers:{'idempotency-key':'0123456789abcdef'}
 },rep);
 assert.equal(input.merchantId,'trusted-merchant');
 assert.equal(input.merchantId!=='attacker-merchant',true);
 assert.equal(rep.status,201);
});
test('operations edge separates read and replay permissions and step-up',()=>{
 const app=fakeApp();registerOperationsRoutes(app,{services:{},guards});
 const health=app.routes.find(x=>x.url.endsWith('/health'));
 const replay=app.routes.find(x=>x.url.includes(':outboxId/replay'));
 assert.equal(health.preHandler[1].name,'permission_lifecycle.health.read');
 assert.equal(replay.preHandler[1].name,'permission_lifecycle.dead_letter.replay');
 assert.equal(replay.preHandler[2].name,'stepup');
});
test('webhook routes are public-auth routes but each has local rate limit and endpoint key',()=>{
 const app=fakeApp();registerWebhookRoutes(app,{webhookEndpoints:{},webhookInbox:{}});
 assert.equal(app.routes.length,2);
 for(const r of app.routes){
  assert.equal(r.preHandler,undefined);
  assert.equal(r.config.rateLimit.max,600);
  assert.match(r.url,/:endpointKey$/);
 }
});
test('invalid Paystack signature cannot reach durable inbox',async()=>{
 const app=fakeApp();let ingested=false;
 registerWebhookRoutes(app,{
  webhookEndpoints:{resolve:async()=>({id:'ep',merchantId:'m',secret:'secret_1234567890123456'})},
  webhookInbox:{ingest:async()=>{ingested=true}}
 });
 const r=app.routes.find(x=>x.url.includes('/payments/'));
 await assert.rejects(()=>r.handler({
  params:{endpointKey:'abcdefghijklmnopqrstuvwx'},
  headers:{'x-paystack-signature':'00'},
  rawBody:Buffer.from('{"event":"charge.success"}'),
  body:{event:'charge.success'}
 },reply()),e=>e.code==='WEBHOOK_SIGNATURE_INVALID');
 assert.equal(ingested,false);
});
test('valid Paystack signature is persisted before 200 acknowledgement',async()=>{
 const app=fakeApp();let ingested=false;
 const secret='secret_1234567890123456';
 const raw=Buffer.from('{"event":"charge.success","data":{"id":5}}');
 const signature=crypto.createHmac('sha512',secret).update(raw).digest('hex');
 registerWebhookRoutes(app,{
  webhookEndpoints:{resolve:async()=>({id:'ep',merchantId:'m',secret})},
  webhookInbox:{ingest:async(x)=>{ingested=x;return {deduplicated:false}}}
 });
 const r=app.routes.find(x=>x.url.includes('/payments/'));
 const rep=reply();
 await r.handler({params:{endpointKey:'abcdefghijklmnopqrstuvwx'},headers:{'x-paystack-signature':signature},rawBody:raw,body:{event:'charge.success',data:{id:5}}},rep);
 assert.equal(Boolean(ingested),true);
 assert.equal(ingested.merchantId,'m');
 assert.equal(rep.status,200);
});
