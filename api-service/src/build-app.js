'use strict';

const { installErrorHandler } = require('./http/problem');
const { createRouteGuards } = require('./security/route-guards');
const { registerTransactionRoutes } = require('./routes/transaction.routes');
const { registerOperationsRoutes } = require('./routes/operations.routes');
const { registerWebhookRoutes } = require('./routes/webhook.routes');
const { registerControlPlaneRoutes } = require('./routes/control-plane.routes');
const { registerRealtimeRoutes } = require('./routes/realtime.routes');
const { registerPaymentRoutes } = require('./routes/payment.routes');

async function buildApp({ config, pool, services, authorization, webhookEndpoints, webhookInbox, realtime, readiness }) {
  const Fastify=require('fastify');
  const jwt=require('@fastify/jwt');
  const rateLimit=require('@fastify/rate-limit');

  const app=Fastify({
    trustProxy:config.trustProxy,
    bodyLimit:1024*1024,
    requestIdHeader:'x-request-id',
    logger:{
      level:config.nodeEnv==='production'?'info':'debug',
      redact:{
        paths:[
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers.x-paystack-signature',
          'req.headers.x-hub-signature-256',
        ],
        censor:'[REDACTED]'
      }
    }
  });

  await app.register(jwt,{
    secret:{public:config.jwtPublicKey},
    verify:{
      algorithms:['RS256'],
      allowedIss:config.jwtIssuer,
      allowedAud:config.jwtAudience,
      checkTyp:'JWT',
    }
  });

  await app.register(rateLimit,{
    global:false,
    max:120,
    timeWindow:'1 minute',
  });

  // Preserve the exact bytes used by webhook providers for signature verification.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json',{parseAs:'buffer'},function(request,body,done){
    try{
      if(request.url.startsWith('/v1/webhooks/')) request.rawBody=Buffer.from(body);
      const text=body.toString('utf8');
      done(null,text.length?JSON.parse(text):{});
    }catch(error){
      error.status=400;
      error.code='INVALID_JSON';
      done(error);
    }
  });

  app.addHook('onSend',async(request,reply,payload)=>{
    reply.header('x-content-type-options','nosniff');
    reply.header('referrer-policy','no-referrer');
    reply.header('cache-control','no-store');
    return payload;
  });

  installErrorHandler(app);
  const guards=createRouteGuards({authorization});

  app.route({
    method:'GET',url:'/livez',config:{rateLimit:false},
    handler:async()=>({status:'ok'})
  });
  app.route({
    method:'GET',url:'/readyz',config:{rateLimit:false},
    handler:async(request,reply)=>{
      await pool.query('SELECT 1');
      if(realtime && !(await realtime.health())) return reply.code(503).send({status:'not_ready',reasons:['redis_unavailable']});
      if(readiness){const state=await readiness.inspect();if(!state.ready)return reply.code(503).send({status:'not_ready',reasons:state.reasons});}
      return reply.send({status:'ready'});
    }
  });

  registerTransactionRoutes(app,{services,guards});
  registerOperationsRoutes(app,{services,guards});
  registerWebhookRoutes(app,{webhookEndpoints,webhookInbox});
  registerControlPlaneRoutes(app,{services,guards});
  registerRealtimeRoutes(app,{guards,realtime});
  registerPaymentRoutes(app,{services,guards});

  return app;
}

module.exports={buildApp};
