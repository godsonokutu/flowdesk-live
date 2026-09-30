'use strict';
class PgSystemReadinessService{
  constructor({pool,limits={}}){this.pool=pool;this.limits={webhookLagMs:limits.webhookLagMs??120000,paymentLagMs:limits.paymentLagMs??120000,sellerEventLagMs:limits.sellerEventLagMs??60000,workerHeartbeatMaxAgeMs:limits.workerHeartbeatMaxAgeMs??30000}}
  async inspect(){const r=(await this.pool.query(`SELECT
    (SELECT EXTRACT(EPOCH FROM(now()-MIN(received_at)))*1000 FROM webhook_inbox WHERE status IN('received','processing')) webhook_lag_ms,
    (SELECT COUNT(*)::int FROM webhook_inbox WHERE status='processing' AND lease_until<now()) webhook_expired_leases,
    (SELECT EXTRACT(EPOCH FROM(now()-MIN(created_at)))*1000 FROM payment_provider_outbox WHERE status='pending') payment_lag_ms,
    (SELECT COUNT(*)::int FROM payment_provider_outbox WHERE status='pending' AND lease_until<now()) payment_expired_leases,
    (SELECT EXTRACT(EPOCH FROM(now()-MIN(created_at)))*1000 FROM seller_event_outbox WHERE status='pending') seller_event_lag_ms,
    (SELECT COUNT(*)::int FROM seller_event_outbox WHERE status='pending' AND lease_until<now()) seller_event_expired_leases,
    (SELECT EXTRACT(EPOCH FROM(now()-MAX(last_seen_at)))*1000 FROM worker_heartbeats WHERE worker_type='webhook') webhook_heartbeat_age_ms,
    (SELECT EXTRACT(EPOCH FROM(now()-MAX(last_seen_at)))*1000 FROM worker_heartbeats WHERE worker_type='payment_provider') payment_heartbeat_age_ms,
    (SELECT EXTRACT(EPOCH FROM(now()-MAX(last_seen_at)))*1000 FROM worker_heartbeats WHERE worker_type='seller_event_publisher') seller_event_heartbeat_age_ms`)).rows[0]||{};
    const n=x=>x==null?null:Number(x),metrics={webhookLagMs:n(r.webhook_lag_ms)??0,webhookExpiredLeases:Number(r.webhook_expired_leases||0),paymentLagMs:n(r.payment_lag_ms)??0,paymentExpiredLeases:Number(r.payment_expired_leases||0),sellerEventLagMs:n(r.seller_event_lag_ms)??0,sellerEventExpiredLeases:Number(r.seller_event_expired_leases||0),webhookHeartbeatAgeMs:n(r.webhook_heartbeat_age_ms),paymentHeartbeatAgeMs:n(r.payment_heartbeat_age_ms),sellerEventHeartbeatAgeMs:n(r.seller_event_heartbeat_age_ms)};
    const reasons=[];if(metrics.webhookLagMs>this.limits.webhookLagMs)reasons.push('webhook_backlog_stale');if(metrics.paymentLagMs>this.limits.paymentLagMs)reasons.push('payment_backlog_stale');if(metrics.sellerEventLagMs>this.limits.sellerEventLagMs)reasons.push('seller_event_backlog_stale');if(metrics.webhookExpiredLeases)reasons.push('webhook_worker_lease_expired');if(metrics.paymentExpiredLeases)reasons.push('payment_worker_lease_expired');if(metrics.sellerEventExpiredLeases)reasons.push('seller_event_worker_lease_expired');
    for(const [name,age] of [['webhook',metrics.webhookHeartbeatAgeMs],['payment',metrics.paymentHeartbeatAgeMs],['seller_event',metrics.sellerEventHeartbeatAgeMs]])if(age===null||age>this.limits.workerHeartbeatMaxAgeMs)reasons.push(`${name}_worker_unhealthy`);
    return{ready:reasons.length===0,reasons,metrics,limits:this.limits}}
}
module.exports={PgSystemReadinessService};
