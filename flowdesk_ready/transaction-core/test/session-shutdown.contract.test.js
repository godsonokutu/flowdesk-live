'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {PgLiveSessionShutdownService}=require('../src/live-session.shutdown.pg');
const {PgLifecycleOutboxWorker}=require('../src/lifecycle.outbox.pg');

function scripted(responses){
  const calls=[];let i=0;
  const client={
    query:async(sql,args=[])=>{
      calls.push({sql:String(sql).replace(/\s+/g,' ').trim(),args});
      const r=responses[i++];
      if(r instanceof Error) throw r;
      if(typeof r==='function') return r({sql,args,calls,index:i-1});
      return r||{rowCount:0,rows:[]};
    },
    release:()=>calls.push({sql:'RELEASE',args:[]})
  };
  return {pool:{connect:async()=>client},calls};
}
const beginInput={
 merchantId:'m',sessionId:'s1',actorId:'op1',
 reason:'Seller intentionally ended the LIVE selling session',
 idempotencyKey:'0123456789abcdef'
};

test('C12 invalid shutdown reason fails before DB access',async()=>{
 let connected=false;
 const svc=new PgLiveSessionShutdownService({pool:{connect:async()=>{connected=true;}}});
 await assert.rejects(()=>svc.beginShutdown({...beginInput,reason:'short'}),e=>e.code==='INVALID_SHUTDOWN_REASON');
 assert.equal(connected,false);
});

test('C12 begin shutdown establishes closing cut-over, cancels waitlist and audits without mutating active reservations',async()=>{
 const s=scripted([
  {},
  {rowCount:1,rows:[{}]},
  {rows:[{id:'s1',status:'live',closing_started_at:null,close_policy:null,ended_at:null}]},
  {rows:[{closing_started_at:'2026-09-30T03:00:00Z'}]},
  {rowCount:2,rows:[{id:'w1'},{id:'w2'}]},
  {rows:[{active_hold_count:3,next_expiry_at:'2026-09-30T03:05:00Z',last_expiry_at:'2026-09-30T03:10:00Z'}]},
  {},
  {rowCount:1},
  {},
 ]);
 const svc=new PgLiveSessionShutdownService({pool:s.pool});
 const out=await svc.beginShutdown(beginInput);
 assert.equal(out.outcome,'closing');
 assert.equal(out.cancelledWaitlistCount,2);
 assert.equal(out.activeHoldCount,3);
 const sessionUpdate=s.calls.findIndex(x=>/UPDATE live_sessions SET status='closing'/.test(x.sql));
 const waitlist=s.calls.findIndex(x=>/UPDATE waitlist_entries SET status='cancelled'/.test(x.sql));
 const audit=s.calls.findIndex(x=>/live_session\.shutdown_started/.test(x.sql));
 const commit=s.calls.findIndex(x=>x.sql==='COMMIT');
 assert.ok(sessionUpdate>0 && waitlist>sessionUpdate && audit>waitlist && audit<commit);
 assert.equal(s.calls.some(x=>/UPDATE reservations/.test(x.sql)),false);
});

test('C12 begin shutdown replay returns stored result and does not create another shutdown audit',async()=>{
 const stored={outcome:'closing',sessionId:'s1',status:'closing',policy:'drain_holds',cancelledWaitlistCount:2,activeHoldCount:1};
 const s=scripted([
  {},
  {rowCount:0,rows:[]},
  {rows:[{request_hash:'HASH',response_body:stored}]},
  {}
 ]);
 const svc=new PgLiveSessionShutdownService({pool:s.pool});
 // Patch the scripted prior hash to exactly what the service inserted.
 s.pool.connect=async()=>({
   query:async(sql,args=[])=>{
     s.calls.push({sql:String(sql).replace(/\s+/g,' ').trim(),args});
     if(/BEGIN/.test(sql)) return {};
     if(/INSERT INTO idempotency_requests/.test(sql)) return {rowCount:0,rows:[]};
     if(/SELECT request_hash,response_body/.test(sql)) return {rows:[{request_hash:args.__hash||null,response_body:stored}]};
     if(/COMMIT/.test(sql)) return {};
     return {};
   },
   release:()=>s.calls.push({sql:'RELEASE',args:[]})
 });
 // Use a separate deterministic emulation because requestHash is internal.
 const real = new PgLiveSessionShutdownService({pool:{
   connect:async()=>{
    let insertedArgs;
    return {
      query:async(sql,args=[])=>{
       const normalized=String(sql).replace(/\s+/g,' ').trim(); s.calls.push({sql:normalized,args});
       if(normalized==='BEGIN') return {};
       if(/INSERT INTO idempotency_requests/.test(normalized)){insertedArgs=args;return {rowCount:0,rows:[]};}
       if(/SELECT request_hash,response_body/.test(normalized)) return {rows:[{request_hash:insertedArgs[2],response_body:stored}]};
       if(normalized==='COMMIT') return {};
       return {};
      },
      release:()=>{}
    };
   }
 }});
 const out=await real.beginShutdown(beginInput);
 assert.equal(out.deduplicated,true);
 assert.equal(s.calls.some(x=>/live_session\.shutdown_started/.test(x.sql)),false);
});

test('C12 finalize returns draining while a valid pre-close hold remains and does not release inventory',async()=>{
 const s=scripted([
  {},
  {rows:[{status:'closing'}]},
  {rows:[{id:'r1',inventory_variant_id:'sku1',quantity:1,status:'active',expires_at:'2026-09-30T03:30:00Z'}]},
  {rows:[{id:'s1',status:'closing',closing_started_at:'2026-09-30T03:00:00Z',close_policy:'drain_holds',ended_at:null,db_now:'2026-09-30T03:20:00Z'}]},
  {rowCount:0,rows:[]},
  {},
 ]);
 const svc=new PgLiveSessionShutdownService({pool:s.pool});
 const out=await svc.finalizeShutdown({merchantId:'m',sessionId:'s1',actorId:'op1'});
 assert.equal(out.outcome,'draining');
 assert.equal(out.activeHoldCount,1);
 assert.equal(s.calls.some(x=>/UPDATE inventory_variants/.test(x.sql)),false);
 assert.equal(s.calls.some(x=>/SET status='ended'/.test(x.sql)),false);
});

test('C12 finalization locks reservation -> session -> inventory, releases due holds, verifies zero orphans, then ends',async()=>{
 const s=scripted([
  {},
  {rows:[{status:'closing'}]},
  {rows:[
   {id:'r1',inventory_variant_id:'sku-a',quantity:2,status:'active',expires_at:'2026-09-30T03:10:00Z'},
   {id:'r2',inventory_variant_id:'sku-a',quantity:1,status:'payment_pending',expires_at:'2026-09-30T03:15:00Z'},
   {id:'r3',inventory_variant_id:'sku-b',quantity:1,status:'active',expires_at:'2026-09-30T03:19:00Z'}
  ]},
  {rows:[{id:'s1',status:'closing',closing_started_at:'2026-09-30T03:00:00Z',close_policy:'drain_holds',ended_at:null,db_now:'2026-09-30T03:20:00Z'}]},
  {rowCount:1,rows:[{id:'w-last'}]},
  {rows:[{id:'sku-a',reserved_qty:3},{id:'sku-b',reserved_qty:1}]},
  {rowCount:1,rows:[{version:'8'}]},
  {rowCount:1,rows:[{version:'5'}]},
  {rowCount:3,rows:[{id:'r1'},{id:'r2'},{id:'r3'}]},
  {rows:[{active_holds:0,waiting:0}]},
  {rows:[{ended_at:'2026-09-30T03:20:00Z'}]},
  {rows:[{count:2}]},
  {},
  {},
 ]);
 const svc=new PgLiveSessionShutdownService({pool:s.pool});
 const out=await svc.finalizeShutdown({merchantId:'m',sessionId:'s1',actorId:'op1'});
 assert.equal(out.outcome,'ended');
 assert.equal(out.expiredReservationCount,3);
 assert.equal(out.releasedQuantity,4);
 assert.equal(out.pendingLifecycleJobs,2);
 const reservationsLock=s.calls.findIndex(x=>/FROM reservations/.test(x.sql)&&/FOR UPDATE/.test(x.sql));
 const sessionLock=s.calls.findIndex(x=>/FROM live_sessions/.test(x.sql)&&/FOR UPDATE/.test(x.sql));
 const inventoryLock=s.calls.findIndex(x=>/FROM inventory_variants/.test(x.sql)&&/FOR UPDATE/.test(x.sql));
 const ended=s.calls.findIndex(x=>/SET status='ended'/.test(x.sql));
 const audit=s.calls.findIndex(x=>/live_session\.ended/.test(x.sql));
 const commit=s.calls.findIndex(x=>x.sql==='COMMIT');
 assert.ok(reservationsLock>0 && sessionLock>reservationsLock && inventoryLock>sessionLock && ended>inventoryLock && audit>ended && audit<commit);
});

test('C12 accounting conflict rolls back and never marks session ended',async()=>{
 const s=scripted([
  {},
  {rows:[{status:'closing'}]},
  {rows:[{id:'r1',inventory_variant_id:'sku1',quantity:2,status:'active',expires_at:'2026-09-30T03:10:00Z'}]},
  {rows:[{id:'s1',status:'closing',db_now:'2026-09-30T03:20:00Z'}]},
  {rowCount:0,rows:[]},
  {rows:[{id:'sku1',reserved_qty:1}]},
  {},
 ]);
 const svc=new PgLiveSessionShutdownService({pool:s.pool});
 await assert.rejects(()=>svc.finalizeShutdown({merchantId:'m',sessionId:'s1',actorId:'op1'}),e=>e.code==='INVENTORY_ACCOUNTING_CONFLICT');
 assert.equal(s.calls.some(x=>/SET status='ended'/.test(x.sql)),false);
 assert.ok(s.calls.some(x=>x.sql==='ROLLBACK'));
});

test('C12 lifecycle worker treats closing session as non-live and cannot promote waitlist',async()=>{
 const job={id:'job1',merchant_id:'m',event_type:'inventory_available',source_type:'reservation_expiry',source_id:'r1',live_session_id:'s1',inventory_variant_id:'sku1',dedupe_key:'d1',payload:{},attempts:0};
 const s=scripted([
  {},
  {rows:[job]},
  {},
  {},
  {rows:[{id:'s1',status:'closing',reservation_ttl_seconds:300}]},
  {},
  {},
 ]);
 const worker=new PgLifecycleOutboxWorker({pool:s.pool});
 const out=await worker.processNext();
 assert.equal(out.outcome,'completed');
 assert.equal(out.result.outcome,'session_not_live');
 assert.equal(s.calls.some(x=>/INSERT INTO reservations/.test(x.sql)),false);
});
