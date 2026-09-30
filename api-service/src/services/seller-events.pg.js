'use strict';
class PgSellerEventOutboxService{constructor({pool}){this.pool=pool}
 async emit({merchantId,sourceType,sourceId,eventType,liveSessionId=null,payload={}}){if(!['webhook_inbox','payment_provider_outbox','transaction','operator'].includes(sourceType))throw new TypeError('unsupported seller-event source');
 const r=await this.pool.query(`INSERT INTO seller_event_outbox(id,merchant_id,live_session_id,event_type,source_type,source_id,payload) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(merchant_id,source_type,source_id,event_type) DO NOTHING RETURNING id`,
 [merchantId,liveSessionId,eventType,sourceType,sourceId,JSON.stringify(payload)]);return{eventId:r.rows?.[0]?.id||null,deduplicated:r.rowCount===0}}
 async emitFromWebhook(x){return this.emit({merchantId:x.merchantId,sourceType:'webhook_inbox',sourceId:x.inboxId,eventType:x.eventType,liveSessionId:x.liveSessionId,payload:x.payload})}}
module.exports={PgSellerEventOutboxService};
