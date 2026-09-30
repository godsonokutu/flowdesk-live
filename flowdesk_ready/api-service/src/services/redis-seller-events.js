'use strict';
function streamKey(m){return `flowdesk:seller-events:${m}`}
function dedupeKey(e){return `flowdesk:seller-event-published:${e}`}
function parseXRead(raw){const out=[];for(const [,entries] of raw||[])for(const [id,fields] of entries||[]){const m={};for(let i=0;i<fields.length;i+=2)m[fields[i]]=fields[i+1];out.push({redisId:id,eventId:m.event_id,eventType:m.event_type,liveSessionId:m.live_session_id||null,payload:JSON.parse(m.payload||'{}'),createdAt:m.created_at||null})}return out}
class RedisSellerEventPublisher{
 constructor({redis,streamMaxLen=100000,dedupeTtlSeconds=604800}){this.redis=redis;this.streamMaxLen=streamMaxLen;this.dedupeTtlSeconds=dedupeTtlSeconds}
 async publish(e){const script=`local prior=redis.call('GET',KEYS[2]);if prior then return {'duplicate',prior} end
 local id=redis.call('XADD',KEYS[1],'MAXLEN','~',ARGV[1],'*','event_id',ARGV[2],'event_type',ARGV[3],'live_session_id',ARGV[4],'payload',ARGV[5],'created_at',ARGV[6])
 redis.call('SET',KEYS[2],id,'EX',ARGV[7]);return {'published',id}`;
 const r=await this.redis.eval(script,{keys:[streamKey(e.merchant_id),dedupeKey(e.id)],arguments:[String(this.streamMaxLen),e.id,e.event_type,e.live_session_id||'',JSON.stringify(e.payload||{}),new Date(e.created_at||Date.now()).toISOString(),String(this.dedupeTtlSeconds)]});
 return{status:r[0],redisId:r[1]}}
}
class RedisSellerEventStream{
 constructor({clientFactory,healthClient=null,blockMs=15000,count=100}){this.clientFactory=clientFactory;this.healthClient=healthClient;this.blockMs=blockMs;this.count=count}
 async health(){const c=this.healthClient||await this.clientFactory();try{if(!c.isOpen&&c.connect)await c.connect();return(await c.ping())==='PONG'}finally{if(!this.healthClient&&c.isOpen&&c.quit)await c.quit()}}
 async streamToResponse({merchantId,sessionId,lastEventId='$',rawResponse,signal}){const c=await this.clientFactory();try{if(!c.isOpen&&c.connect)await c.connect();let cursor=lastEventId;
  while(!signal?.aborted){const raw=await c.sendCommand(['XREAD','COUNT',String(this.count),'BLOCK',String(this.blockMs),'STREAMS',streamKey(merchantId),cursor]);for(const e of parseXRead(raw)){cursor=e.redisId;if(e.liveSessionId&&e.liveSessionId!==sessionId)continue;rawResponse.write(`id: ${e.redisId}\nevent: ${e.eventType}\ndata: ${JSON.stringify({eventId:e.eventId,liveSessionId:e.liveSessionId,payload:e.payload,createdAt:e.createdAt})}\n\n`)}if(!raw)rawResponse.write(': keepalive\n\n')}}
  finally{if(c.isOpen&&c.quit)await c.quit()}}
}
module.exports={streamKey,dedupeKey,parseXRead,RedisSellerEventPublisher,RedisSellerEventStream};
