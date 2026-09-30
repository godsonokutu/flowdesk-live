'use strict';
class ConfigError extends Error {}
function required(env,key){const v=env[key];if(typeof v!=='string'||!v.trim())throw new ConfigError(`${key} is required`);return v}
function int(env,key,def,min=1,max=Number.MAX_SAFE_INTEGER){const n=Number(env[key]??def);if(!Number.isInteger(n)||n<min||n>max)throw new ConfigError(`${key} invalid`);return n}
function loadConfig(env=process.env){
 const nodeEnv=env.NODE_ENV||'development',port=int(env,'PORT',8080,1,65535),apiReplicaCount=int(env,'FLOWDESK_API_REPLICA_COUNT',1);
 const cfg={nodeEnv,port,host:env.HOST||'0.0.0.0',databaseUrl:required(env,'DATABASE_URL'),jwtPublicKey:required(env,'JWT_PUBLIC_KEY'),
 jwtIssuer:required(env,'JWT_ISSUER'),jwtAudience:required(env,'JWT_AUDIENCE'),trustProxy:env.TRUST_PROXY==='true',apiReplicaCount,
 edgeDistributedRateLimit:env.FLOWDESK_EDGE_DISTRIBUTED_RATE_LIMIT==='true',secretResolverModule:required(env,'FLOWDESK_SECRET_RESOLVER_MODULE'),
 redisUrl:required(env,'REDIS_URL'),readiness:{webhookLagMs:int(env,'READINESS_WEBHOOK_MAX_LAG_MS',120000,1000),paymentLagMs:int(env,'READINESS_PAYMENT_MAX_LAG_MS',120000,1000),sellerEventLagMs:int(env,'READINESS_SELLER_EVENT_MAX_LAG_MS',60000,1000),workerHeartbeatMaxAgeMs:int(env,'READINESS_WORKER_HEARTBEAT_MAX_AGE_MS',30000,5000)}};
 if(nodeEnv==='production'&&apiReplicaCount>1&&!cfg.edgeDistributedRateLimit)throw new ConfigError('multi-replica production requires FLOWDESK_EDGE_DISTRIBUTED_RATE_LIMIT=true');
 return Object.freeze(cfg)
}
function loadWorkerConfig(env=process.env){return Object.freeze({databaseUrl:required(env,'DATABASE_URL'),concurrency:int(env,'WEBHOOK_WORKER_CONCURRENCY',4,1,32)})}
function loadRealtimeConfig(env=process.env){return Object.freeze({redisUrl:required(env,'REDIS_URL'),publisherConcurrency:int(env,'SELLER_EVENT_PUBLISHER_CONCURRENCY',4,1,32),
 streamMaxLen:int(env,'SELLER_EVENT_STREAM_MAXLEN',100000,1000,10000000),dedupeTtlSeconds:int(env,'SELLER_EVENT_DEDUPE_TTL_SECONDS',604800,3600,2592000)})}
module.exports={loadConfig,loadWorkerConfig,loadRealtimeConfig,ConfigError};
