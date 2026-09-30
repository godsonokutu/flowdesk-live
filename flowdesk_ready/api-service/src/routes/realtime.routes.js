'use strict';
function registerRealtimeRoutes(app,{guards,realtime}){app.route({method:'GET',url:'/v1/live-sessions/:sessionId/events/stream',
 schema:{params:{type:'object',required:['sessionId'],additionalProperties:false,properties:{sessionId:{type:'string',format:'uuid'}}}},
 preHandler:[guards.authenticate,guards.requirePermission('seller.events.read')],config:{rateLimit:{max:30,timeWindow:'1 minute'}},
 handler:async(req,reply)=>{reply.hijack();reply.raw.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache, no-transform','connection':'keep-alive','x-accel-buffering':'no','x-content-type-options':'nosniff'});
 const controller=new AbortController(),close=()=>controller.abort();req.raw.once('close',close);try{await realtime.streamToResponse({merchantId:req.auth.merchantId,sessionId:req.params.sessionId,lastEventId:req.headers['last-event-id']||'$',rawResponse:reply.raw,signal:controller.signal})}finally{req.raw.off?.('close',close);if(!reply.raw.destroyed)reply.raw.end()}}})}
module.exports={registerRealtimeRoutes};
