'use strict';
const {ProviderPayloadError}=require('./errors');
function parseIntentText(text){if(typeof text!=='string')return{kind:'review',reason:'unsupported_message'};
 const n=text.trim().replace(/\s+/g,' ').toUpperCase();let m=null;
 for(const p of [/^BUY\s+([A-Z0-9_-]{1,40})(?:\s+(?:X\s*)?([0-9]{1,6}))?$/,/^([A-Z0-9_-]{1,40})\s+X\s*([0-9]{1,6})$/,/^([A-Z0-9_-]{1,40})\s+([0-9]{1,6})$/,/^([A-Z0-9_-]{1,40})$/]){m=n.match(p);if(m)break}
 if(!m)return{kind:'review',reason:'intent_unrecognized',normalizedText:n};const q=m[2]==null?1:Number(m[2]);
 if(!Number.isInteger(q)||q<1||q>1000)return{kind:'review',reason:'invalid_quantity',normalizedText:n};
 return{kind:'buy',alias:m[1],quantity:q,normalizedText:n}}
function normalizeWhatsAppEvent(p){const v=p?.entry?.[0]?.changes?.[0]?.value,m=v?.messages?.[0];if(!m)return Object.freeze({kind:'ignored',reason:'no_inbound_message'});
 if(typeof m.id!=='string'||!m.id)throw new ProviderPayloadError('WHATSAPP_MESSAGE_ID_INVALID','message id invalid');
 if(typeof m.from!=='string'||!m.from)throw new ProviderPayloadError('WHATSAPP_SENDER_INVALID','sender invalid');let t=null;
 if(m.type==='text')t=m.text?.body;else if(m.type==='button')t=m.button?.payload||m.button?.text;else if(m.type==='interactive'){t=m.interactive?.button_reply?.id||m.interactive?.list_reply?.id;
 if(typeof t==='string'&&t.startsWith('flowdesk:buy:')){const a=t.split(':');if(a.length===4)t=`${a[2]} ${a[3]}`}}
 return Object.freeze({...parseIntentText(t),provider:'meta_whatsapp',messageId:m.id,externalBuyerId:m.from,displayName:v?.contacts?.[0]?.profile?.name?.slice(0,200)||null,rawMessageType:m.type||'unknown'})}
module.exports={normalizeWhatsAppEvent,parseIntentText};
