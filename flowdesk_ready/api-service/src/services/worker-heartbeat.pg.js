'use strict';
class PgWorkerHeartbeatService {
  constructor({pool,workerType,instanceId,metadata={}}){if(!pool||!workerType||!instanceId)throw new TypeError('pool, workerType and instanceId required');Object.assign(this,{pool,workerType,instanceId,metadata})}
  async beat(){await this.pool.query(`INSERT INTO worker_heartbeats(worker_type,instance_id,metadata) VALUES($1,$2,$3::jsonb)
    ON CONFLICT(worker_type,instance_id) DO UPDATE SET last_seen_at=now(),metadata=EXCLUDED.metadata`,[this.workerType,this.instanceId,JSON.stringify(this.metadata)])}
  async remove(){await this.pool.query('DELETE FROM worker_heartbeats WHERE worker_type=$1 AND instance_id=$2',[this.workerType,this.instanceId])}
  start({intervalMs=10000,onError=()=>{}}={}){let stopped=false,timer=null;const tick=async()=>{if(stopped)return;try{await this.beat()}catch(e){onError(e)}finally{if(!stopped)timer=setTimeout(tick,intervalMs);timer?.unref?.()}};void tick();return async()=>{stopped=true;if(timer)clearTimeout(timer);try{await this.remove()}catch(e){onError(e)}}}
}
module.exports={PgWorkerHeartbeatService};
