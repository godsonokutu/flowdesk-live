'use strict';
const { verifyPaystackSignature, verifyMetaSignature } = require('../security/webhook-signatures');

function registerWebhookRoutes(app, { webhookEndpoints, webhookInbox }) {
  const endpointKeySchema={
    params:{
      type:'object',required:['endpointKey'],additionalProperties:false,
      properties:{endpointKey:{type:'string',minLength:24,maxLength:96,pattern:'^[A-Za-z0-9_-]+$'}}
    }
  };

  app.route({
    method:'POST',
    url:'/v1/webhooks/payments/:endpointKey',
    schema:endpointKeySchema,
    config:{rateLimit:{max:600,timeWindow:'1 minute'},rawBody:true},
    handler:async(request,reply)=>{
      const endpoint=await webhookEndpoints.resolve({
        endpointKey:request.params.endpointKey,
        expectedProvider:'paystack',
      });
      verifyPaystackSignature({
        rawBody:request.rawBody,
        signature:request.headers['x-paystack-signature'],
        secret:endpoint.secret,
      });
      const result=await webhookInbox.ingest({
        endpointId:endpoint.id,
        merchantId:endpoint.merchantId,
        provider:'paystack',
        payload:request.body,
        rawBody:request.rawBody,
      });
      return reply.code(200).send({accepted:true,deduplicated:result.deduplicated});
    }
  });

  app.route({
    method:'POST',
    url:'/v1/webhooks/whatsapp/:endpointKey',
    schema:endpointKeySchema,
    config:{rateLimit:{max:600,timeWindow:'1 minute'},rawBody:true},
    handler:async(request,reply)=>{
      const endpoint=await webhookEndpoints.resolve({
        endpointKey:request.params.endpointKey,
        expectedProvider:'meta_whatsapp',
      });
      verifyMetaSignature({
        rawBody:request.rawBody,
        signature:request.headers['x-hub-signature-256'],
        secret:endpoint.secret,
      });
      const result=await webhookInbox.ingest({
        endpointId:endpoint.id,
        merchantId:endpoint.merchantId,
        provider:'meta_whatsapp',
        payload:request.body,
        rawBody:request.rawBody,
      });
      return reply.code(200).send({accepted:true,deduplicated:result.deduplicated});
    }
  });
}

module.exports={registerWebhookRoutes};
