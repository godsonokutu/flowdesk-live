'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {PgAuthorizationService}=require('../src/services/authorization.pg');
const {PgWebhookEndpointService}=require('../src/services/webhook-endpoints.pg');
const {PgWebhookInboxService,extractProviderEventId}=require('../src/services/webhook-inbox.pg');

test('authorization membership requires active status',async()=>{
 const svc=new PgAuthorizationService({pool:{query:async()=>({rows:[{status:'active'}]})}});
 assert.equal(await svc.assertMembership({merchantId:'m',actorId:'a'}),true);
});
test('authorization rejects suspended membership',async()=>{
 const svc=new PgAuthorizationService({pool:{query:async()=>({rows:[{status:'suspended'}]})}});
 await assert.rejects(()=>svc.assertMembership({merchantId:'m',actorId:'a'}),e=>e.code==='MERCHANT_MEMBERSHIP_REQUIRED');
});
test('permission check is database authoritative',async()=>{
 const calls=[];
 const svc=new PgAuthorizationService({pool:{query:async(sql,args)=>{calls.push({sql,args});return {rowCount:1,rows:[{}]}}}});
 await svc.assertPermission({merchantId:'m',actorId:'a',permission:'reservation.force_allocate'});
 assert.deepEqual(calls[0].args,['m','a','reservation.force_allocate']);
 assert.match(calls[0].sql,/m\.status='active'/);
});
test('permission denial fails closed',async()=>{
 const svc=new PgAuthorizationService({pool:{query:async()=>({rowCount:0,rows:[]})}});
 await assert.rejects(()=>svc.assertPermission({merchantId:'m',actorId:'a',permission:'x'}),e=>e.code==='PERMISSION_REQUIRED');
});
test('webhook endpoint resolves tenant by opaque endpoint key then secret reference',async()=>{
 const secretCalls=[];
 const svc=new PgWebhookEndpointService({
  pool:{query:async()=>({rows:[{id:'ep1',merchant_id:'m1',provider:'paystack',secret_ref:'kms/paystack/m1',verify_token_ref:null,status:'active'}]})},
  secretResolver:{resolve:async(ref)=>{secretCalls.push(ref);return 'secret-value-1234567890'}}
 });
 const out=await svc.resolve({endpointKey:'abcdefghijklmnopqrstuvwx',expectedProvider:'paystack'});
 assert.equal(out.merchantId,'m1');
 assert.deepEqual(secretCalls,['kms/paystack/m1']);
});
test('webhook endpoint does not reveal provider mismatch',async()=>{
 const svc=new PgWebhookEndpointService({
  pool:{query:async()=>({rows:[{id:'ep1',merchant_id:'m1',provider:'meta_whatsapp',secret_ref:'x',status:'active'}]})},
  secretResolver:{resolve:async()=>{throw new Error('must not resolve')}}
 });
 await assert.rejects(()=>svc.resolve({endpointKey:'abcdefghijklmnopqrstuvwx',expectedProvider:'paystack'}),e=>e.code==='WEBHOOK_ENDPOINT_NOT_FOUND');
});
test('Paystack event id prefers stable transaction identity',()=>{
 const id=extractProviderEventId('paystack',{data:{id:777,reference:'ref'}},Buffer.from('{}'));
 assert.equal(id,'paystack:777');
});
test('WhatsApp event id uses wamid message id',()=>{
 const payload={entry:[{changes:[{value:{messages:[{id:'wamid.abc'}]}}]}]};
 assert.equal(extractProviderEventId('meta_whatsapp',payload,Buffer.from('{}')),'whatsapp:wamid.abc');
});
test('unknown provider event identity falls back to exact payload hash',()=>{
 const raw=Buffer.from('{"x":1}');
 assert.match(extractProviderEventId('paystack',{data:{}},raw),/^payload:[0-9a-f]{64}$/);
});
test('webhook inbox is durable and dedupe-aware',async()=>{
 const calls=[];
 const svc=new PgWebhookInboxService({pool:{query:async(sql,args)=>{calls.push({sql,args});return {rowCount:1,rows:[{id:'in1'}]}}}});
 const raw=Buffer.from('{"event":"charge.success","data":{"id":5}}');
 const out=await svc.ingest({endpointId:'ep',merchantId:'m',provider:'paystack',payload:{event:'charge.success',data:{id:5}},rawBody:raw});
 assert.equal(out.inboxId,'in1');
 assert.equal(out.deduplicated,false);
 assert.match(calls[0].sql,/ON CONFLICT \(webhook_endpoint_id,provider_event_id\) DO NOTHING/);
 assert.equal(calls[0].args[1],'m');
});
test('duplicate webhook inbox insert returns accepted deduplicated without replaying business mutation',async()=>{
 const svc=new PgWebhookInboxService({pool:{query:async()=>({rowCount:0,rows:[]})}});
 const out=await svc.ingest({endpointId:'ep',merchantId:'m',provider:'paystack',payload:{data:{id:5}},rawBody:Buffer.from('{}')});
 assert.equal(out.accepted,true);
 assert.equal(out.deduplicated,true);
 assert.equal(out.inboxId,null);
});
