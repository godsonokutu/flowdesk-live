'use strict';
const {ProviderPayloadError}=require('../providers/errors');
class PgPaymentIntentService{constructor({pool}){this.pool=pool}
 async resolveSuccessfulCharge({merchantId,providerReference,amountMinor,currency}){
  const row=(await this.pool.query(`SELECT p.id,p.reservation_id,p.amount_minor,p.currency,p.status,r.id provider_reference_id,r.state provider_reference_state
   FROM payment_provider_references r JOIN payment_intents p ON p.id=r.payment_intent_id AND p.merchant_id=r.merchant_id
   WHERE r.merchant_id=$1 AND r.provider='paystack' AND r.reference=$2 LIMIT 1`,[merchantId,providerReference])).rows?.[0];
  if(!row)throw new ProviderPayloadError('PAYMENT_INTENT_NOT_FOUND','successful charge has no FlowDesk payment reference');
  const a=Number(row.amount_minor),c=String(row.currency).toUpperCase();
  if(a!==amountMinor||c!==currency){await this.pool.query(`UPDATE payment_intents SET status='reconciliation_required',updated_at=now() WHERE id=$1 AND merchant_id=$2`,[row.id,merchantId]);
   throw new ProviderPayloadError('PAYMENT_INTENT_MISMATCH','provider charge does not match expected amount/currency',{status:409})}
  return{id:row.id,reservationId:row.reservation_id,amountMinor:a,currency:c,status:row.status,providerReferenceState:row.provider_reference_state}}
 async applySettlementResult({merchantId,paymentIntentId,result}){const status=['paid','already_paid'].includes(result?.outcome)?'settled':result?.outcome==='reconciliation_required'?'reconciliation_required':'pending';
  await this.pool.query(`UPDATE payment_intents SET status=$3,updated_at=now() WHERE id=$1 AND merchant_id=$2`,[paymentIntentId,merchantId,status]);return status}}
module.exports={PgPaymentIntentService};
