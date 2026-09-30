'use strict';
const crypto=require('node:crypto');
class PgWhatsAppIntentService{constructor({pool,reservation}){this.pool=pool;this.reservation=reservation}
 async ensureBuyerIdentity({merchantId,externalBuyerId,displayName}){return(await this.pool.query(`INSERT INTO buyer_identities(id,merchant_id,channel,external_id,display_name)
 VALUES(gen_random_uuid(),$1,'whatsapp',$2,$3) ON CONFLICT(merchant_id,channel,external_id) DO UPDATE SET display_name=COALESCE(EXCLUDED.display_name,buyer_identities.display_name),updated_at=now() RETURNING id`,
 [merchantId,externalBuyerId,displayName])).rows[0].id}
 async resolveOffer({merchantId,alias}){const rows=(await this.pool.query(`SELECT a.live_session_id,a.inventory_variant_id FROM live_offer_aliases a JOIN live_sessions s ON s.id=a.live_session_id AND s.merchant_id=a.merchant_id
 WHERE a.merchant_id=$1 AND a.alias=$2 AND a.status='active' AND s.status='live' ORDER BY a.live_session_id LIMIT 2`,[merchantId,alias])).rows;
 if(!rows.length)return{kind:'review',reason:'offer_not_found'};if(rows.length>1)return{kind:'review',reason:'offer_ambiguous'};return{kind:'resolved',sessionId:rows[0].live_session_id,inventoryVariantId:rows[0].inventory_variant_id}}
 async review({merchantId,inboxId,buyerIdentityId,event,reason}){const r=await this.pool.query(`INSERT INTO buyer_intent_review(id,merchant_id,webhook_inbox_id,buyer_identity_id,provider_message_id,reason,normalized_text,metadata)
 VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(webhook_inbox_id) DO NOTHING RETURNING id`,
 [merchantId,inboxId,buyerIdentityId,event.messageId,reason,event.normalizedText||null,JSON.stringify({alias:event.alias||null,quantity:event.quantity||null,rawMessageType:event.rawMessageType})]);
 return{outcome:'review_required',reason,buyerIdentityId,reviewId:r.rows?.[0]?.id||null}}
 async processNormalized({merchantId,inboxId,event}){if(event.kind==='ignored')return{outcome:'ignored',reason:event.reason};const buyerIdentityId=await this.ensureBuyerIdentity({merchantId,externalBuyerId:event.externalBuyerId,displayName:event.displayName});
 if(event.kind==='review')return this.review({merchantId,inboxId,buyerIdentityId,event,reason:event.reason});const offer=await this.resolveOffer({merchantId,alias:event.alias});
 if(offer.kind==='review')return this.review({merchantId,inboxId,buyerIdentityId,event,reason:offer.reason});const key=`wa:${crypto.createHash('sha256').update(`${merchantId}:${event.messageId}`).digest('hex')}`;
 const result=await this.reservation.acceptBuyerIntent({merchantId,sessionId:offer.sessionId,inventoryVariantId:offer.inventoryVariantId,buyerId:buyerIdentityId,quantity:event.quantity,idempotencyKey:key,providerEventId:event.messageId});
 return{outcome:result.outcome,buyerIdentityId,sessionId:offer.sessionId,inventoryVariantId:offer.inventoryVariantId,quantity:event.quantity,reservation:result.reservation||null,waitlist:result.waitlist||null}}}
module.exports={PgWhatsAppIntentService};
