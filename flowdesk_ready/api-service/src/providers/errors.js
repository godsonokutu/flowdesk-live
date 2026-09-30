'use strict';
class ProviderPayloadError extends Error{constructor(code,message,{status=422,retryable=false}={}){super(message);this.code=code;this.status=status;this.retryable=retryable}}
const RETRYABLE=new Set(['40001','40P01','55P03','08006','53300','57P01','57P02','57P03']);
function isRetryableProcessingError(e){return Boolean(e&&(e.retryable===true||e.status>=500||RETRYABLE.has(e.code)))}
function safeError(e){return `${e?.code||'UNKNOWN'}: ${e?.message||'webhook failure'}`.slice(0,2000)}
module.exports={ProviderPayloadError,isRetryableProcessingError,safeError};
