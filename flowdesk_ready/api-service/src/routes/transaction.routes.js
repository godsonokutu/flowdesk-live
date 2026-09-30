'use strict';
const { requireIdempotencyKey, requireInventoryVersion } = require('../security/request-guards');

const uuid = { type: 'string', format: 'uuid' };
const idempotencyHeaders = {
  type: 'object',
  required: ['idempotency-key'],
  properties: { 'idempotency-key': { type: 'string', minLength: 16, maxLength: 200 } },
  additionalProperties: true,
};

function registerTransactionRoutes(app, { services, guards }) {
  const auth = guards.authenticate;
  const member = guards.requireMembership();

  app.route({
    method: 'POST',
    url: '/v1/live-sessions/:sessionId/buyer-intents',
    schema: {
      params: { type:'object', required:['sessionId'], properties:{sessionId:uuid}, additionalProperties:false },
      headers: idempotencyHeaders,
      body: {
        type:'object', additionalProperties:false,
        required:['inventory_variant_id','buyer_id'],
        properties:{
          inventory_variant_id:uuid,
          buyer_id:uuid,
          quantity:{type:'integer',minimum:1,maximum:1000},
          provider_event_id:{type:['string','null'],maxLength:200},
        }
      }
    },
    preHandler: [auth, member],
    config: { rateLimit: { max: 240, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      const result = await services.reservation.acceptBuyerIntent({
        merchantId: request.auth.merchantId,
        sessionId: request.params.sessionId,
        inventoryVariantId: request.body.inventory_variant_id,
        buyerId: request.body.buyer_id,
        quantity: request.body.quantity ?? 1,
        providerEventId: request.body.provider_event_id ?? null,
        idempotencyKey: requireIdempotencyKey(request.headers),
      });
      return reply.code(201).send(result);
    },
  });

  app.route({
    method:'POST',
    url:'/v1/reservations/:reservationId/cancel',
    schema:{
      params:{type:'object',required:['reservationId'],properties:{reservationId:uuid},additionalProperties:false},
      headers:idempotencyHeaders,
      body:{type:'object',additionalProperties:false,properties:{}}
    },
    preHandler:[auth,member],
    config:{rateLimit:{max:120,timeWindow:'1 minute'}},
    handler:async(request,reply)=>{
      requireIdempotencyKey(request.headers);
      const result=await services.lifecycle.cancelReservation({
        merchantId:request.auth.merchantId,
        reservationId:request.params.reservationId,
      });
      return reply.code(200).send(result);
    }
  });

  app.route({
    method:'POST',
    url:'/v1/reservations/:reservationId/switch-variant',
    schema:{
      params:{type:'object',required:['reservationId'],properties:{reservationId:uuid},additionalProperties:false},
      headers:idempotencyHeaders,
      body:{
        type:'object',additionalProperties:false,required:['destination_inventory_variant_id'],
        properties:{
          destination_inventory_variant_id:uuid,
          reason:{type:'string',minLength:8,maxLength:500},
        }
      }
    },
    preHandler:[auth,member],
    config:{rateLimit:{max:120,timeWindow:'1 minute'}},
    handler:async(request,reply)=>{
      const result=await services.variant.switchVariant({
        merchantId:request.auth.merchantId,
        reservationId:request.params.reservationId,
        destinationInventoryVariantId:request.body.destination_inventory_variant_id,
        idempotencyKey:requireIdempotencyKey(request.headers),
        actorType:'operator',
        actorId:request.auth.actorId,
        reason:request.body.reason || 'Operator changed the reserved variant',
      });
      return reply.code(200).send(result);
    }
  });

  app.route({
    method:'POST',
    url:'/v1/operator-overrides/force-allocation',
    schema:{
      headers:{
        type:'object',
        required:['idempotency-key','if-inventory-version'],
        properties:{
          'idempotency-key':{type:'string',minLength:16,maxLength:200},
          'if-inventory-version':{type:'string',pattern:'^(0|[1-9][0-9]{0,18})$'},
        },
        additionalProperties:true
      },
      body:{
        type:'object',additionalProperties:false,
        required:['session_id','inventory_variant_id','buyer_id','reason'],
        properties:{
          session_id:uuid,inventory_variant_id:uuid,buyer_id:uuid,
          quantity:{type:'integer',minimum:1,maximum:1000},
          reason:{type:'string',minLength:8,maxLength:500},
        }
      }
    },
    preHandler:[
      auth,
      guards.requirePermission('reservation.force_allocate'),
      guards.requireStepUp(10*60*1000),
    ],
    config:{rateLimit:{max:30,timeWindow:'1 minute'}},
    handler:async(request,reply)=>{
      const result=await services.override.forceAllocate({
        merchantId:request.auth.merchantId,
        sessionId:request.body.session_id,
        inventoryVariantId:request.body.inventory_variant_id,
        buyerId:request.body.buyer_id,
        quantity:request.body.quantity ?? 1,
        idempotencyKey:requireIdempotencyKey(request.headers),
        actorId:request.auth.actorId,
        permissions:['reservation.force_allocate'],
        stepUpVerifiedAt:request.auth.stepUpVerifiedAt,
        reason:request.body.reason,
        expectedInventoryVersion:requireInventoryVersion(request.headers),
      });
      return reply.code(201).send(result);
    }
  });

  app.route({
    method:'POST',
    url:'/v1/live-sessions/:sessionId/shutdown',
    schema:{
      params:{type:'object',required:['sessionId'],properties:{sessionId:uuid},additionalProperties:false},
      headers:idempotencyHeaders,
      body:{type:'object',additionalProperties:false,required:['reason'],properties:{reason:{type:'string',minLength:8,maxLength:500}}}
    },
    preHandler:[auth,guards.requirePermission('live_session.end'),guards.requireStepUp(10*60*1000)],
    config:{rateLimit:{max:20,timeWindow:'1 minute'}},
    handler:async(request,reply)=>{
      const result=await services.shutdown.beginShutdown({
        merchantId:request.auth.merchantId,
        sessionId:request.params.sessionId,
        actorId:request.auth.actorId,
        reason:request.body.reason,
        idempotencyKey:requireIdempotencyKey(request.headers),
      });
      return reply.code(result.outcome==='already_ended'?200:202).send(result);
    }
  });

  app.route({
    method:'POST',
    url:'/v1/live-sessions/:sessionId/shutdown/finalize',
    schema:{
      params:{type:'object',required:['sessionId'],properties:{sessionId:uuid},additionalProperties:false},
      body:{type:'object',additionalProperties:false,properties:{reason:{type:'string',minLength:8,maxLength:500}}}
    },
    preHandler:[auth,guards.requirePermission('live_session.end')],
    config:{rateLimit:{max:60,timeWindow:'1 minute'}},
    handler:async(request,reply)=>{
      const result=await services.shutdown.finalizeShutdown({
        merchantId:request.auth.merchantId,
        sessionId:request.params.sessionId,
        actorId:request.auth.actorId,
        reason:request.body?.reason || 'All active holds resolved or expired',
      });
      return reply.code(200).send(result);
    }
  });
}

module.exports = { registerTransactionRoutes };
