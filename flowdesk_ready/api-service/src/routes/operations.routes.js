'use strict';

function registerOperationsRoutes(app, { services, guards }) {
  const auth=guards.authenticate;

  app.route({
    method:'GET',
    url:'/v1/operations/lifecycle/health',
    preHandler:[auth,guards.requirePermission('lifecycle.health.read')],
    config:{rateLimit:{max:120,timeWindow:'1 minute'}},
    handler:async(request,reply)=>reply.send(await services.operations.getHealth({
      merchantId:request.auth.merchantId,actorId:request.auth.actorId,
    }))
  });

  app.route({
    method:'GET',
    url:'/v1/operations/lifecycle/dead-letters',
    schema:{
      querystring:{
        type:'object',additionalProperties:false,
        properties:{
          limit:{type:'integer',minimum:1,maximum:100,default:50},
          before_created_at:{type:'string',format:'date-time'},
        }
      }
    },
    preHandler:[auth,guards.requirePermission('lifecycle.dead_letter.read')],
    config:{rateLimit:{max:120,timeWindow:'1 minute'}},
    handler:async(request,reply)=>reply.send({
      items:await services.operations.listDeadLetters({
        merchantId:request.auth.merchantId,
        actorId:request.auth.actorId,
        limit:request.query.limit ?? 50,
        beforeCreatedAt:request.query.before_created_at ?? null,
      })
    })
  });

  app.route({
    method:'POST',
    url:'/v1/operations/lifecycle/dead-letters/:outboxId/replay',
    schema:{
      params:{type:'object',required:['outboxId'],properties:{outboxId:{type:'string',format:'uuid'}},additionalProperties:false},
      body:{type:'object',additionalProperties:false,required:['reason'],properties:{reason:{type:'string',minLength:8,maxLength:500}}}
    },
    preHandler:[
      auth,
      guards.requirePermission('lifecycle.dead_letter.replay'),
      guards.requireStepUp(10*60*1000),
    ],
    config:{rateLimit:{max:20,timeWindow:'1 minute'}},
    handler:async(request,reply)=>reply.code(202).send(await services.operations.replayDeadLetter({
      merchantId:request.auth.merchantId,
      actorId:request.auth.actorId,
      outboxId:request.params.outboxId,
      reason:request.body.reason,
    }))
  });
}

module.exports={registerOperationsRoutes};
