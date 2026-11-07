'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');

function makeWorker(shared = { local: {}, session: {}, notices: [], focused: [] }) {
  let messageListener, updateListener, removeListener, clickListener;
  const extensionId = 'notification-test-extension';
  const chrome = {
    runtime: {
      id: extensionId,
      getURL(file) { return 'chrome-extension://' + extensionId + '/' + file; },
      onMessage: { addListener(fn) { messageListener = fn; } },
      async getContexts() { return shared.audioDocument ? [{documentUrl:'offscreen.html'}] : []; },
      async sendMessage(message) {
        (shared.audioMessages ||= []).push(message);
        return message.action === 'stop' ? {stopped:true} : {played:!shared.rejectAudio};
      }
    },
    commands: { onCommand: { addListener() {} } },
    offscreen: {
      async createDocument(options) {
        shared.audioCreated = (shared.audioCreated || 0) + 1;
        shared.audioDocument = true;
        shared.audioOptions = options;
      }
    },
    storage: {
      local: {
        async get(keys) {
          const names = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(names.map(name => [name, shared.local[name]]));
        },
        async set(data) { Object.assign(shared.local, JSON.parse(JSON.stringify(data))); }
      },
      session: {
        async get(key) { return { [key]: shared.session[key] }; },
        async set(data) { Object.assign(shared.session, JSON.parse(JSON.stringify(data))); },
        async remove(key) { delete shared.session[key]; }
      }
    },
    notifications: {
      async create(id, options) {
        if (shared.blocked) throw Error('OS notifications unavailable');
        shared.notices.push({id, options});
        return id;
      },
      async getPermissionLevel() { return shared.permission || 'granted'; },
      onClicked: { addListener(fn) { clickListener = fn; } }
    },
    tabs: {
      onUpdated: { addListener(fn) { updateListener = fn; } },
      onRemoved: { addListener(fn) { removeListener = fn; } },
      async get(tabId) {
        if (shared.missingTab) throw Error('Tab closed');
        return {id:tabId,windowId:9,url:shared.tabUrl || 'https://chatgpt.com/c/abc'};
      },
      async update(tabId, props) {
        shared.focused.push(['tab', tabId, props.active]);
        return {id:tabId,windowId:9};
      }
    },
    windows: {
      async update(windowId, props) { shared.focused.push(['window',windowId,props.focused]); }
    }
  };
  const ctx = vm.createContext({
    URL, Date, Promise, Math, Set, Map, console, chrome,
    crypto: require('node:crypto').webcrypto
  });
  ctx.importScripts = (...files) => files.forEach(file =>
    vm.runInContext(fs.readFileSync(path.join(ROOT, file),'utf8'), ctx, {filename:file}));
  vm.runInContext(fs.readFileSync(path.join(ROOT,'background.js'),'utf8'),ctx,{filename:'background.js'});
  function sendRaw(message, tabId = 17, url = 'https://chatgpt.com/c/abc') {
    return new Promise(resolve => {
      const handled = messageListener(message, {
        id: extensionId, frameId: 0, url, tab: {id:tabId}
      }, resolve);
      if (!handled) resolve({ok:false,error:'blocked'});
    });
  }
  const api = {
    shared,
    send(action, runId='test-run-12345678', opts = {}, tabId = 17) {
      return sendRaw({app:'qfc-v1.1',command:'runLifecycle',action,runId,...opts},tabId);
    },
    unauthorized(action, runId='test-run-12345678') {
      return sendRaw({app:'qfc-v1.1',command:'runLifecycle',action,runId},
        17,'https://invalid.example/c/abc');
    },
    flush() { return sendRaw({app:'qfc-v1.1',command:'getWorkflows'}); },
    rpc(command, fields = {}) { return sendRaw({app:'qfc-v1.1',command,...fields}); },
    async updated(tabId, info) { updateListener(tabId, info); await api.flush(); },
    async removed(tabId) { removeListener(tabId); await api.flush(); },
    async click(id) { clickListener(id); await new Promise(resolve => setImmediate(resolve)); }
  };
  return api;
}

test('verified workflow completes with one notification and click focuses its tab', async () => {
  const w = makeWorker();
  const run = 'audit-run-12345678';
  assert.equal((await w.send('start',run,{workflowName:'MyRiser Security Audit'})).ok, true);
  assert.equal((await w.send('success',run,{verifiedCount:8,workflowName:'MyRiser Security Audit'})).ok,true);
  await w.send('success',run,{verifiedCount:8,workflowName:'MyRiser Security Audit'});
  await w.updated(17,{discarded:true});
  assert.equal(w.shared.notices.length,1);
  const n = w.shared.notices[0];
  assert.match(n.options.title,/Workflow completed successfully/);
  assert.match(n.options.message,/All 8 prompts finished · MyRiser Security Audit/);
  assert.match(n.options.iconUrl,/icons\/icon128\.png$/);
  assert.equal(Object.keys(w.shared.session).length,0);
  await w.click(n.id);
  assert.equal(w.shared.focused[0][1],17);
  assert.equal(w.shared.focused[1][1],9);
});

test('automatic interruption emits one alert; manual pause and foreign senders stay silent',async()=>{
  const w=makeWorker();
  const run='safety-run-123456';
  await w.send('start',run,{workflowName:'MyRiser Security Audit'});
  await w.send('interrupted',run,{verifiedCount:2,reason:'response',workflowName:'MyRiser Security Audit'});
  await w.send('interrupted',run,{verifiedCount:2,reason:'response'});
  assert.equal(w.shared.notices.length,1);
  assert.match(w.shared.notices[0].options.message,/Response completion could not be confirmed · 2 verified/);
  await w.send('start','manual-run-123456');
  await w.send('manual','manual-run-123456');
  await w.send('success','manual-run-123456',{verifiedCount:2});
  assert.equal(w.shared.notices.length,1);
  assert.equal((await w.unauthorized('start')).ok,false);
  assert.equal(w.shared.notices.length,1);
});

test('tab discard survives worker restart, loading race and no double notification',async()=>{
  const shared={local:{},session:{},notices:[],focused:[]};
  const w1=makeWorker(shared);
  await w1.send('start','discard-run-1234',{workflowName:'MyRiser Security Audit'},23);
  assert.equal(Object.keys(shared.session).length,1);
  const w2=makeWorker(shared);
  await w2.updated(23,{status:'loading'});
  assert.equal(shared.notices.length,0);
  await w2.updated(23,{status:'loading',discarded:true});
  await w2.updated(23,{status:'complete'});
  assert.equal(shared.notices.length,1);
  assert.match(shared.notices[0].options.message,/Chrome discarded the running ChatGPT tab/);
  assert.equal(Object.keys(shared.session).length,0);
});

test('normal page reload and user-closed tab clear metadata without alerts',async()=>{
  const w=makeWorker();
  await w.send('start','reload-run-12345',{},15);
  await w.updated(15,{status:'loading'});
  await w.updated(15,{status:'complete'});
  await w.updated(15,{discarded:true});
  assert.equal(w.shared.notices.length,0);
  await w.send('start','close-run-123456',{},16);
  await w.removed(16);
  await w.updated(16,{discarded:true});
  assert.equal(w.shared.notices.length,0);
  assert.equal(Object.keys(w.shared.session).length,0);
});

test('denied notification calls and stale run IDs never affect coordinator',async()=>{
  const shared={local:{},session:{},notices:[],focused:[],blocked:true};
  const w=makeWorker(shared);
  await w.send('start','old-run-12345678');
  await w.send('start','new-run-12345678');
  const stale=await w.send('success','old-run-12345678',{verifiedCount:5});
  assert.equal(stale.data.accepted,false);
  const ok=await w.send('success','new-run-12345678',{verifiedCount:1});
  assert.equal(ok.ok,true);
  assert.equal(shared.notices.length,0);
  assert.equal(Object.keys(shared.session).length,0);
  // A notification error cannot prevent ordinary queue coordinator operations.
  assert.equal((await w.flush()).ok,true);
});

test('queue and mixed-workflow runs avoid a misleading workflow title',async()=>{
  const w=makeWorker();
  await w.send('start','mixed-run-12345678',{workflowName:'Workflow A'});
  await w.send('success','mixed-run-12345678',{verifiedCount:3,workflowName:''});
  assert.equal(w.shared.notices.length,1);
  assert.equal(w.shared.notices[0].options.title,'Queue completed successfully');
  assert.match(w.shared.notices[0].options.message,/All 3 prompts finished/);
});

test('notification click does not open tabs or focus unrelated pages',async()=>{
  const shared={local:{},session:{},notices:[],focused:[],tabUrl:'https://example.com/'};
  const w=makeWorker(shared);
  await w.click('qfc-run-22-example-run-12345');
  assert.equal(shared.focused.length,0);
  shared.tabUrl='https://chatgpt.com/c/abc';
  shared.missingTab=true;
  await w.click('qfc-run-22-example-run-12345');
  assert.equal(shared.focused.length,0);
});

test('custom chime uses silent desktop notification and only one offscreen document', async()=>{
  const shared={local:{qfc_v1_notification_settings:{
    enabled:true,onSuccess:true,onInterrupted:true,
    sound:'double',soundDuration:'10',soundVolume:85,visibility:'persistent'
  }},session:{},notices:[],focused:[]};
  const w=makeWorker(shared);
  await w.send('start','audio-run-12345678');
  await w.send('success','audio-run-12345678',{verifiedCount:2});
  await w.flush();
  assert.equal(shared.notices.length,1);
  assert.equal(shared.notices[0].options.silent,true);
  assert.equal(shared.notices[0].options.requireInteraction,true);
  assert.equal(shared.audioCreated,1);
  assert.equal(shared.audioOptions.reasons[0],'AUDIO_PLAYBACK');
  assert.equal(shared.audioMessages[0].sound,'double');
  assert.equal(shared.audioMessages[0].duration,'10');
  assert.equal(shared.audioMessages[0].volume,85);

  await w.send('start','second-run-12345678');
  await w.send('success','second-run-12345678',{verifiedCount:1});
  await w.flush();
  assert.equal(shared.audioCreated,1,'reuse the existing offscreen document');
  assert.equal(shared.audioMessages.length,2);
});
test('notifications opt-out, disabled outcomes and silent custom sound are respected',async()=>{
  const shared={local:{},session:{},notices:[],focused:[]};
  const w=makeWorker(shared);
  shared.local.qfc_v1_notification_settings={
    enabled:false,onSuccess:true,onInterrupted:true,sound:'alert',soundDuration:'20',soundVolume:75,visibility:'persistent'
  };
  await w.send('start','disabled-run-123456');
  await w.send('success','disabled-run-123456',{verifiedCount:1});
  assert.equal(shared.notices.length,0);
  shared.local.qfc_v1_notification_settings.enabled=true;
  shared.local.qfc_v1_notification_settings.onInterrupted=false;
  await w.send('start','muted-stop-123456');
  await w.send('interrupted','muted-stop-123456',{reason:'send'});
  await w.send('start','discard-stop-1234',{},19);
  await w.updated(19,{discarded:true});
  assert.equal(shared.notices.length,0);
  shared.local.qfc_v1_notification_settings.sound='silent';
  await w.send('start','silent-run-123456');
  await w.send('success','silent-run-123456',{verifiedCount:1});
  assert.equal(shared.notices.length,1);
  assert.equal(shared.notices[0].options.silent,true);
  assert.equal(shared.audioCreated,undefined);
});
test('sound preview validates values, ignores foreign origins and keeps queue RPC responsive',async()=>{
  const w=makeWorker();
  const accepted=await w.rpc('previewSound',{sound:'soft',duration:'5',volume:75});
  assert.equal(accepted.data.played,true);
  assert.equal(w.shared.audioMessages[0].sound,'soft');
  assert.equal(w.shared.audioMessages[0].volume,75);
  assert.equal((await w.rpc('previewSound',{sound:'untrusted',duration:'20',volume:75})).data.played,false);
  assert.equal((await w.rpc('previewSound',{sound:'soft',duration:'1000',volume:75})).data.played,false);
  assert.equal((await w.rpc('previewSound',{sound:'soft',duration:'60',volume:101})).data.played,false);
  assert.equal((await w.rpc('previewSound',{sound:'soft',duration:'2',volume:0})).data.played,false);
  assert.equal(w.shared.audioMessages.length,1);
  assert.equal((await w.rpc('notificationPermission')).data,'granted');
  assert.equal((await w.unauthorized('start')).ok,false);
  assert.equal((await w.flush()).ok,true);
});
test('invalid notification preference values return conservative defaults',async()=>{
  const shared={local:{qfc_v1_notification_settings:{
    enabled:'false',onSuccess:'false',onInterrupted:1,
    sound:'audio-from-the-internet',soundDuration:'99999',soundVolume:999,visibility:'endless'
  }},session:{},notices:[],focused:[]};
  const w=makeWorker(shared);
  await w.send('start','defaults-run-1234');
  await w.send('success','defaults-run-1234',{verifiedCount:1});
  assert.equal(shared.notices.length,1);
  assert.equal(shared.notices[0].options.silent,false);
  assert.equal(shared.notices[0].options.requireInteraction,false);
  assert.equal(shared.audioMessages,undefined);
});

test('explicit silent test notification does not register a run or produce custom audio',async()=>{
  const w=makeWorker();
  const result=await w.rpc('testNotification');
  assert.equal(result.data.requested,true);
  assert.equal(w.shared.notices.length,1);
  assert.equal(w.shared.notices[0].options.silent,true);
  assert.match(w.shared.notices[0].options.title,/test notification/);
  assert.deepEqual(Object.keys(w.shared.session),[]);
  assert.equal(w.shared.audioMessages,undefined);
  w.shared.local.qfc_v1_notification_settings={enabled:false};
  assert.equal((await w.rpc('testNotification')).data.requested,false);
  assert.equal(w.shared.notices.length,1);
});
test('zero custom volume never opens audio and stopping never creates a document',async()=>{
  const shared={local:{qfc_v1_notification_settings:{
    enabled:true,onSuccess:true,onInterrupted:true,sound:'soft',
    soundDuration:'60',soundVolume:0,visibility:'system'
  }},session:{},notices:[],focused:[]};
  const w=makeWorker(shared);
  assert.equal((await w.rpc('stopSound')).data.stopped,true);
  assert.equal(shared.audioCreated,undefined);
  await w.send('start','mute-run-12345678');
  await w.send('success','mute-run-12345678',{verifiedCount:1});
  assert.equal(shared.notices.length,1);
  assert.equal(shared.notices[0].options.silent,true);
  assert.equal(shared.audioCreated,undefined);
  assert.equal((await w.rpc('previewSound',{sound:'soft',duration:'60',volume:0})).data.played,false);
  assert.equal((await w.rpc('previewSound',{sound:'soft',duration:'60',volume:100})).data.played,true);
  assert.equal((await w.rpc('stopSound')).data.stopped,true);
  assert.equal(shared.audioMessages.at(-1).action,'stop');
});
