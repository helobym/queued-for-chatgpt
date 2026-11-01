'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const base = path.resolve(__dirname, '..');
const QFC = require('../core.js');
const M = require('../coordinator.js');
let op = 0;
function rid(){return 'workflow-op-' + (++op);}
function worker(initial={}) {
  let listener;
  const stored = JSON.parse(JSON.stringify(initial));
  const ctx = vm.createContext({URL, Date, Promise, Math, Set, console, crypto: require('node:crypto').webcrypto,
    chrome:{runtime:{id:'qfc-test',onMessage:{addListener(fn){listener=fn;}}},storage:{local:{
      async get(keys){return Object.fromEntries(keys.map(key=>[key,stored[key]]));},
      async set(items){Object.assign(stored,JSON.parse(JSON.stringify(items)));}
    }}}});
  ctx.importScripts = (...paths) => paths.forEach(file=>vm.runInContext(fs.readFileSync(path.join(base,file),'utf8'),ctx,{filename:file}));
  vm.runInContext(fs.readFileSync(path.join(base,'background.js'),'utf8'),ctx,{filename:'background.js'});
  return {stored, send(message){return new Promise(resolve => listener({app:'qfc-v1.1',...message}, {id:'qfc-test',frameId:0,url:'https://chatgpt.com/c/abc'},resolve));}};
}
async function ok(promise){const r=await promise;assert.equal(r.ok,true,r.error);return r.data;}
test('saved workflows require a name and valid nonempty prompt steps',()=>{
  assert.throws(()=>M.mutateWorkflows([],{type:'create',name:'  ',steps:['a']}),/name/);
  assert.throws(()=>M.mutateWorkflows([],{type:'create',name:'Research',steps:[' ']}),/nonempty/);
  const result=M.mutateWorkflows([],{type:'create',name:'Research',steps:['One','Two']});
  assert.equal(result[0].steps.length,2);
  assert.throws(()=>M.mutateWorkflows(result,{type:'create',name:'  RESEARCH ',steps:['Other']}),/already exists/);
});
test('service worker snapshots pending queue as ordered workflow and leaves queue untouched',async()=>{
  const w=worker();
  await ok(w.send({command:'queue',route:'chat:abc',operationId:rid(),mutation:{type:'add',text:'First'}}));
  await ok(w.send({command:'queue',route:'chat:abc',operationId:rid(),mutation:{type:'add',text:'Second'}}));
  const saveId=rid();
  const record=await ok(w.send({command:'saveQueueWorkflow',route:'chat:abc',operationId:saveId,name:'My research'}));
  const retry=await ok(w.send({command:'saveQueueWorkflow',route:'chat:abc',operationId:saveId,name:'My research'}));
  assert.equal(retry.items.length,1);
  assert.deepEqual(Array.from(record.items[0].steps),['First','Second']);
  const queue=await ok(w.send({command:'getQueue',route:'chat:abc'}));
  assert.equal(queue.items.length,2);
});
test('snapshot only includes pending prompts and excludes in-flight prompt',async()=>{
  const w=worker();
  const a=await ok(w.send({command:'queue',route:'chat:abc',operationId:rid(),mutation:{type:'add',text:'Sending'}}));
  await ok(w.send({command:'queue',route:'chat:abc',operationId:rid(),mutation:{type:'sending',id:a.items[0].id}}));
  await ok(w.send({command:'queue',route:'chat:abc',operationId:rid(),mutation:{type:'add',text:'Pending'}}));
  const rec=await ok(w.send({command:'saveQueueWorkflow',route:'chat:abc',operationId:rid(),name:'Safe'}));
  assert.deepEqual(Array.from(rec.items[0].steps),['Pending']);
});
test('load workflow into another chat is atomic and idempotent under retries',async()=>{
  const w=worker();
  const created=await ok(w.send({command:'workflows',operationId:rid(),mutation:{type:'create',name:'Steps',steps:['One','Two']}}));
  const workflowId=created.items[0].id, operationId=rid();
  const command={command:'appendWorkflow',route:'chat:other',workflowId,operationId};
  await ok(w.send(command)); await ok(w.send(command));
  const rec=await ok(w.send({command:'getQueue',route:'chat:other'}));
  assert.deepEqual(Array.from(rec.items.map(q=>q.text)), ['One','Two']);
});
test('loading during an active queue appends after existing prompts and preserves the in-flight item',async()=>{
  const w=worker();
  const workflows=await ok(w.send({command:'workflows',operationId:rid(),
    mutation:{type:'create',name:'Next steps',steps:['Workflow one','Workflow two']}}));
  let queue=await ok(w.send({command:'queue',route:'chat:abc',operationId:rid(),
    mutation:{type:'add',text:'Running first'}}));
  const firstId=queue.items[0].id;
  await ok(w.send({command:'queue',route:'chat:abc',operationId:rid(),
    mutation:{type:'add',text:'Pending second'}}));
  await ok(w.send({command:'queue',route:'chat:abc',operationId:rid(),
    mutation:{type:'sending',id:firstId}}));
  await ok(w.send({command:'queue',route:'chat:abc',operationId:rid(),
    mutation:{type:'awaiting',id:firstId}}));
  queue=await ok(w.send({command:'appendWorkflow',route:'chat:abc',
    workflowId:workflows.items[0].id,operationId:rid()}));
  assert.deepEqual(Array.from(queue.items.map(item=>item.text)),
    ['Running first','Pending second','Workflow one','Workflow two']);
  assert.equal(queue.items[0].status,'awaiting');
  assert.ok(queue.items.slice(1).every(item=>item.status==='pending'));
  queue=await ok(w.send({command:'queue',route:'chat:abc',operationId:rid(),
    mutation:{type:'complete',id:firstId}}));
  assert.deepEqual(Array.from(queue.items.map(item=>item.text)),
    ['Pending second','Workflow one','Workflow two']);
});
test('atomic workflow append rejects overflow without partial changes',async()=>{
  const w=worker();
  const created=await ok(w.send({command:'workflows',operationId:rid(),mutation:{type:'create',name:'Two',steps:['One','Two']}}));
  const initial=Array.from({length:99},(_,i)=>QFC.newQueueItem('Other '+i));
  w.stored[QFC.queueKey('chat:other')]=M.record(initial,1,[]);
  const r=await w.send({command:'appendWorkflow',route:'chat:other',workflowId:created.items[0].id,operationId:rid()});
  assert.equal(r.ok,false);assert.match(r.error,/Not enough room/);
  assert.equal((await ok(w.send({command:'getQueue',route:'chat:other'}))).items.length,99);
});
test('two tabs adding separate workflows preserve both; stale same-workflow edit rejected',async()=>{
  const w=worker();
  await Promise.all(['First','Second'].map(name=>ok(w.send({command:'workflows',operationId:rid(),mutation:{type:'create',name,steps:['A','B']}}))));
  const rec=await ok(w.send({command:'getWorkflows'}));assert.equal(rec.items.length,2);
  const target=rec.items[0];
  await ok(w.send({command:'workflows',operationId:rid(),mutation:{type:'edit',id:target.id,name:'Updated',steps:['A','C'],expectedUpdatedAt:target.updatedAt}}));
  const stale=await w.send({command:'workflows',operationId:rid(),mutation:{type:'edit',id:target.id,name:'Stale',steps:['Z'],expectedUpdatedAt:target.updatedAt}});
  assert.equal(stale.ok,false);assert.match(stale.error,/another tab/);
});
test('import/export format validates and deduplicates by workflow name',async()=>{
  const w=worker();
  const payload={app:'Queued for ChatGPT',kind:'workflows',workflows:[{name:'Draft',steps:['Alpha','Beta']} ]};
  await ok(w.send({command:'workflows',operationId:rid(),mutation:{type:'import',payload}}));
  await ok(w.send({command:'workflows',operationId:rid(),mutation:{type:'import',payload}}));
  assert.equal((await ok(w.send({command:'getWorkflows'}))).items.length,1);
  const unsafe=await w.send({command:'workflows',operationId:rid(),mutation:{type:'import',payload:{...payload,kind:'legacy-favorites'}}});
  assert.equal(unsafe.ok,false);
});
test('old Favorites remain in storage and are exportable but not migrated to workflows',async()=>{
  const original=[{id:'fav',text:'A favorite',sources:['sent']}];
  const w=worker({[QFC.FAV_KEY]: M.record(original,2,[])});
  const fresh=await ok(w.send({command:'getWorkflows'}));
  assert.equal(fresh.items.length,0);
  const legacy=await ok(w.send({command:'exportLegacyFavorites'}));
  assert.equal(legacy.favorites[0].text,'A favorite');
  assert.ok(w.stored[QFC.FAV_KEY]);
});

test('workflows enforce per-workflow and aggregate lightweight storage limits',()=>{
  assert.throws(()=>QFC.cleanWorkflowSteps(Array.from({length:8}, ()=>'x'.repeat(19000))),/150,000/);
  // Existing library occupies most of the total budget; new workflow cannot grow it further.
  const stored=M.record(Array.from({length:5},(_,i)=>({
    id: 'w'+i, name:'Workflow '+i,steps:Array.from({length:10},()=> 'x'.repeat(14900)),createdAt:0,updatedAt:0
  })), 1, []);
  assert.throws(()=>M.transact(stored,'workflows',{type:'create',name:'Extra',steps:['x'.repeat(10000)]},rid()),/750,000/);
});
