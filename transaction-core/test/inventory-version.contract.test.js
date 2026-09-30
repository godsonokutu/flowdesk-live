'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {
  normalizeExpectedInventoryVersion,
  assertInventoryVersionMatch,
  InventoryVersionError,
}=require('../src/inventory.version-precondition');

test('C09 inventory version accepts canonical non-negative integer header',()=>{
 assert.equal(normalizeExpectedInventoryVersion('0'),0);
 assert.equal(normalizeExpectedInventoryVersion('42'),42);
 assert.equal(normalizeExpectedInventoryVersion(7),7);
});

test('C09 missing inventory version fails closed with HTTP 428 semantics',()=>{
 assert.throws(()=>normalizeExpectedInventoryVersion(undefined),e=>e instanceof InventoryVersionError&&e.code==='INVENTORY_VERSION_REQUIRED'&&e.status===428);
});

test('C09 malformed inventory version is rejected',()=>{
 for(const value of ['-1','01','1.5','abc','',NaN,Infinity]){
  assert.throws(()=>normalizeExpectedInventoryVersion(value),e=>e.code==='INVALID_INVENTORY_VERSION'||e.code==='INVENTORY_VERSION_REQUIRED');
 }
});

test('C09 authoritative version mismatch is a stale-state conflict',()=>{
 assert.throws(()=>assertInventoryVersionMatch('9',8),e=>e.code==='STALE_INVENTORY_VERSION'&&e.status===409);
 assert.equal(assertInventoryVersionMatch('9',9),9);
});
