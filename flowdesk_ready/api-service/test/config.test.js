'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {loadConfig}=require('../src/config/load-config');

function env(extra={}){
 return {
  DATABASE_URL:'postgres://u:p@db/app',
  JWT_PUBLIC_KEY:'-----BEGIN PUBLIC KEY-----x-----END PUBLIC KEY-----',
  JWT_ISSUER:'https://identity.example',
  JWT_AUDIENCE:'flowdesk-api',
  FLOWDESK_SECRET_RESOLVER_MODULE:'/app/secret-resolver.js',
  REDIS_URL:'redis://redis:6379',
  ...extra
 };
}
test('config fails startup when security-critical secrets/config are missing',()=>{
 assert.throws(()=>loadConfig({}),/DATABASE_URL is required/);
});
test('multi-replica production refuses in-memory-only rate limit posture',()=>{
 assert.throws(()=>loadConfig(env({NODE_ENV:'production',FLOWDESK_API_REPLICA_COUNT:'2'})),/DISTRIBUTED_RATE_LIMIT/);
});
test('multi-replica production accepts declared distributed edge rate limit',()=>{
 const c=loadConfig(env({NODE_ENV:'production',FLOWDESK_API_REPLICA_COUNT:'2',FLOWDESK_EDGE_DISTRIBUTED_RATE_LIMIT:'true'}));
 assert.equal(c.apiReplicaCount,2);
 assert.equal(c.edgeDistributedRateLimit,true);
});
