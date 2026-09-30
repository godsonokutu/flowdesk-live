'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {readHeader,requireInventoryVersionHeader}=require('../src/seller-mutation.precondition');

test('C09 header extractor is case-insensitive for Node-style headers',()=>{
 assert.equal(readHeader({'if-inventory-version':'7'},'If-Inventory-Version'),'7');
 assert.equal(readHeader({'IF-INVENTORY-VERSION':'8'},'If-Inventory-Version'),'8');
});

test('C09 header extractor accepts Headers-like adapters',()=>{
 const h={get:(name)=>name==='If-Inventory-Version'?'12':null};
 assert.equal(requireInventoryVersionHeader(h),12);
});

test('C09 missing seller mutation precondition fails closed',()=>{
 assert.throws(()=>requireInventoryVersionHeader({}),e=>e.code==='INVENTORY_VERSION_REQUIRED'&&e.status===428);
});
