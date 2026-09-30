'use strict';
const { Pool }=require('pg');
const { createClient }=require('redis');
const { loadConfig }=require('./config/load-config');
const { buildApp }=require('./build-app');
const { PgAuthorizationService }=require('./services/authorization.pg');
const { PgWebhookEndpointService }=require('./services/webhook-endpoints.pg');
const { PgWebhookInboxService }=require('./services/webhook-inbox.pg');
const { PgLiveOfferService }=require('./services/live-offers.pg');
const { PgBuyerIntentReviewService }=require('./services/buyer-intent-review.pg');
const { PgWebhookHealthService }=require('./services/webhook-health.pg');
const { PgSellerEventOutboxService }=require('./services/seller-events.pg');
const { RedisSellerEventStream }=require('./services/redis-seller-events');
const { PgPaymentCheckoutService }=require('./services/payment-checkout.pg');
const { PgSystemReadinessService }=require('./services/system-readiness.pg');

const { PgReservationService }=require('../../transaction-core/src/reservation.pg');
const { PgReservationLifecycleService }=require('../../transaction-core/src/reservation.lifecycle.pg');
const { PgReservationVariantService }=require('../../transaction-core/src/reservation.variant.pg');
const { PgReservationOverrideService }=require('../../transaction-core/src/reservation.override.pg');
const { PgLiveSessionShutdownService }=require('../../transaction-core/src/live-session.shutdown.pg');
const { PgLifecycleOperationsService }=require('../../transaction-core/src/lifecycle.operations.pg');

async function main(){
  const config=loadConfig();
  const pool=new Pool({
    connectionString:config.databaseUrl,
    max:Number(process.env.DB_POOL_MAX||20),
    application_name:'flowdesk-api',
    statement_timeout:Number(process.env.DB_STATEMENT_TIMEOUT_MS||5000),
    query_timeout:Number(process.env.DB_QUERY_TIMEOUT_MS||6000),
  });

  const resolverFactory=require(config.secretResolverModule);
  const secretResolver=await resolverFactory({config});
  const redis=createClient({url:config.redisUrl});
  redis.on('error',error=>console.error('FlowDesk Redis error',error?.message||error));
  await redis.connect();
  const realtime=new RedisSellerEventStream({healthClient:redis,clientFactory:async()=>redis.duplicate()});
  const readiness=new PgSystemReadinessService({pool,limits:config.readiness});
  const authorization=new PgAuthorizationService({pool});
  const webhookEndpoints=new PgWebhookEndpointService({pool,secretResolver});
  const webhookInbox=new PgWebhookInboxService({pool});

  const services={
    reservation:new PgReservationService({pool}),
    lifecycle:new PgReservationLifecycleService({pool}),
    variant:new PgReservationVariantService({pool}),
    override:new PgReservationOverrideService({pool}),
    shutdown:new PgLiveSessionShutdownService({pool}),
    operations:new PgLifecycleOperationsService({pool,authorize:(args)=>authorization.assertPermission(args)}),
    offers:new PgLiveOfferService({pool}),
    webhookHealth:new PgWebhookHealthService({pool}),
    paymentCheckout:new PgPaymentCheckoutService({pool}),
  };
  services.intentReviews=new PgBuyerIntentReviewService({pool,reservation:services.reservation,sellerEvents:new PgSellerEventOutboxService({pool})});

  const app=await buildApp({
    config,pool,services,authorization,webhookEndpoints,webhookInbox,realtime,readiness
  });

  let stopping=false;
  async function stop(signal){
    if(stopping) return;
    stopping=true;
    app.log.info({signal},'graceful shutdown started');
    const hard=setTimeout(()=>process.exit(1),15_000).unref();
    try{
      await app.close();
      await Promise.allSettled([pool.end(),redis.quit()]);
      clearTimeout(hard);
      process.exit(0);
    }catch(error){
      app.log.error({err:error},'graceful shutdown failed');
      process.exit(1);
    }
  }
  process.once('SIGTERM',()=>stop('SIGTERM'));
  process.once('SIGINT',()=>stop('SIGINT'));

  await pool.query('SELECT 1');
  await app.listen({host:config.host,port:config.port});
}

if(require.main===module){
  main().catch((error)=>{
    console.error('FlowDesk API startup failed',error?.message||error);
    process.exit(1);
  });
}

module.exports={main};
