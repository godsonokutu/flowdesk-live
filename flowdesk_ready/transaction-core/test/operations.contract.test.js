'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {PgLifecycleOperationsService}=require('../src/lifecycle.operations.pg');

function scripted(responses){
 const calls=[];let i=0;
 const client={query:async(sql,args=[])=>{calls.push({sql:String(sql).replace(/\s+/g,' ').trim(),args});const r=responses[i++];if(r instanceof Error)throw r;return r||{rowCount:0,rows:[]};},release:()=>calls.push({sql:'RELEASE',args:[]})};
 return {pool:{connect:async()=>client},calls};
}

test('health read requires explicit permission before DB access',async()=>{
 let connected=false;
 const svc=new PgLifecycleOperationsService({pool:{connect:async()=>{connected=true;}},authorize:async()=>{throw Object.assign(new Error('forbidden'),{code:'FORBIDDEN'});}});
 await assert.rejects(()=>svc.getHealth({merchantId:'m',actorId:'a'}),/forbidden/);
 assert.equal(connected,false);
});

test('health summary exposes backlog and dead-letter safety signals',async()=>{
 const s=scripted([
  {rows:[{pending_count:'4',dead_letter_count:'2',retrying_count:'1',oldest_pending_age_seconds:38.2,last_completed_at:'2026-09-29T12:00:00Z'}]},
  {rows:[{event_type:'inventory_available',status:'completed',count:'20'},{event_type:'inventory_available',status:'dead_letter',count:'2'}]},
 ]);
 const svc=new PgLifecycleOperationsService({pool:s.pool,authorize:async()=>true});
 const out=await svc.getHealth({merchantId:'m',actorId:'a'});
 assert.deepEqual({p:out.pendingCount,d:out.deadLetterCount,r:out.retryingCount},{p:4,d:2,r:1});
 assert.equal(out.oldestPendingAgeSeconds,38.2);
 assert.equal(out.last24h[1].count,2);
});

test('dead-letter replay preserves immutable payload and writes audit event',async()=>{
 const s=scripted([
  {},
  {rows:[{id:'j1',event_type:'inventory_available',source_type:'reservation_expiry',source_id:'r1',payload:{reason:'ttl'},status:'dead_letter',attempts:8}]},
  {}, {}, {},
 ]);
 const permissions=[];
 const svc=new PgLifecycleOperationsService({pool:s.pool,authorize:async x=>permissions.push(x)});
 const out=await svc.replayDeadLetter({merchantId:'m',actorId:'op1',outboxId:'j1',reason:'Verified transient database incident'});
 assert.equal(out.outcome,'replay_queued');
 assert.equal(permissions[0].permission,'lifecycle.dead_letter.replay');
 const update=s.calls.find(x=>/UPDATE lifecycle_outbox SET status='pending'/.test(x.sql));
 assert.ok(update);
 assert.equal(/payload=/.test(update.sql),false);
 const audit=s.calls.find(x=>/lifecycle.dead_letter.replayed/.test(x.sql));
 assert.ok(audit);
 assert.equal(audit.args[1],'op1');
});

test('replay rejects non-dead-letter event and rolls back',async()=>{
 const s=scripted([{}, {rows:[{id:'j1',status:'pending',attempts:1}]}, {}]);
 const svc=new PgLifecycleOperationsService({pool:s.pool,authorize:async()=>true});
 await assert.rejects(()=>svc.replayDeadLetter({merchantId:'m',actorId:'op1',outboxId:'j1',reason:'Retry after incident review'}),e=>e.code==='OUTBOX_NOT_DEAD_LETTER');
 assert.ok(s.calls.some(x=>x.sql==='ROLLBACK'));
});

test('short replay reason is rejected before DB access',async()=>{
 let connected=false;
 const svc=new PgLifecycleOperationsService({pool:{connect:async()=>{connected=true;}},authorize:async()=>true});
 await assert.rejects(()=>svc.replayDeadLetter({merchantId:'m',actorId:'a',outboxId:'j',reason:'retry'}),e=>e.code==='INVALID_REPLAY_REASON');
 assert.equal(connected,false);
});
