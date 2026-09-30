'use strict';
const {ProviderPayloadError}=require('./errors');
function normalizePaystackEvent(p){if(!p||typeof p!=='object')throw new ProviderPayloadError('PAYSTACK_PAYLOAD_INVALID','payload invalid');
 if(p.event!=='charge.success')return Object.freeze({kind:'ignored',reason:'unsupported_event'});
 const d=p.data;if(!d||typeof d!=='object')throw new ProviderPayloadError('PAYSTACK_DATA_REQUIRED','charge data missing');
 const id=d.id,reference=d.reference,amount=Number(d.amount),currency=typeof d.currency==='string'?d.currency.toUpperCase():'';
 if((typeof id!=='number'&&typeof id!=='string')||!String(id))throw new ProviderPayloadError('PAYSTACK_TRANSACTION_ID_INVALID','transaction id invalid');
 if(typeof reference!=='string'||!reference||reference.length>200)throw new ProviderPayloadError('PAYSTACK_REFERENCE_INVALID','reference invalid');
 if(!Number.isSafeInteger(amount)||amount<0)throw new ProviderPayloadError('PAYSTACK_AMOUNT_INVALID','amount invalid');
 if(!/^[A-Z]{3}$/.test(currency))throw new ProviderPayloadError('PAYSTACK_CURRENCY_INVALID','currency invalid');
 return Object.freeze({kind:'payment_success',provider:'paystack',providerTransactionId:String(id),providerReference:reference,amountMinor:amount,currency})}
module.exports={normalizePaystackEvent};
