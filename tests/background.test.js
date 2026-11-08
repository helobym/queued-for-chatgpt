'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const base = path.resolve(__dirname, '..');
function createWorker(stored = {}) {
  let listener, commandListener, actionListener, rejectSend = false;
  const sent = [], injected = [], css = [];
  const activeTabs = new Set();
  const db = JSON.parse(JSON.stringify(stored));
  const ext = { id: 'test-extension' };
  const context = vm.createContext({
    URL, Date, Promise, Math, Set, console, crypto: require('node:crypto').webcrypto,
    chrome: {
      commands: { onCommand: { addListener(fn) { commandListener = fn; } } },
      action: { onClicked: { addListener(fn) { actionListener = fn; } } },
      scripting: {
        async insertCSS(opts) { css.push(['insert',opts.target.tabId]); },
        async removeCSS(opts) { css.push(['remove',opts.target.tabId]); },
        async executeScript(opts) { injected.push([opts.target.tabId,...opts.files]); }
      },
      tabs: {
        async query() { return [{id:42,url:'https://chatgpt.com/c/mychat'}]; },
        async get(id) { return {id,url:'https://chatgpt.com/c/mychat'}; },
        async sendMessage(id, message) {
          if (rejectSend) throw new Error('No receiving end');
          sent.push({id, message});
          if (message.action === 'status') {
            if (!activeTabs.has(id)) throw new Error('No receiving end');
            return {active:true};
          }
          if (message.action === 'open-panel') { activeTabs.add(id); return {active:true}; }
          return {active:true};
        }
      },
      runtime: { id: ext.id, onMessage: { addListener(fn) { listener = fn; } } },
      storage: { local: {
        async get(keys) { const select = Array.isArray(keys) ? keys : [keys]; return Object.fromEntries(select.map(k => [k, db[k]])); },
        async set(values) { Object.assign(db, JSON.parse(JSON.stringify(values))); }
      } }
    }
  });
  context.importScripts = (...paths) => paths.forEach(file => vm.runInContext(fs.readFileSync(path.join(base, file), 'utf8'), context, { filename: file }));
  vm.runInContext(fs.readFileSync(path.join(base, 'background.js'), 'utf8'), context, { filename: 'background.js' });
  return { db, sent, injected, css,
    command(command, tab) { return commandListener(command, tab); },
    action(tab) { return actionListener(tab); },
    rejectReceiver() { rejectSend = true; },
    message(payload) {
    return new Promise(resolve => {
      const allowed = listener({ app: 'qfc-v1.1', ...payload }, { id: ext.id, frameId: 0, url: 'https://chatgpt.com/c/mychat' }, resolve);
      if (!allowed) resolve({ ok: false, error: 'blocked' });
    });
  }, forbidden(payload) {
    return listener({ app: 'qfc-v1.1', ...payload }, { id: ext.id, frameId: 0, url: 'https://other.example/c/mychat' }, () => {});
  } };
}
let count = 0;
function nextId() { return `unique-operation-${++count}`; }
test('actual service-worker serializes simultaneous changes from two simulated tabs', async () => {
  const bg = createWorker();
  const mutation = text => ({ command: 'queue', route: 'chat:mychat', operationId: nextId(), mutation: { type: 'add', text } });
  const [a,b,c] = await Promise.all([bg.message(mutation('A')), bg.message(mutation('B')), bg.message(mutation('C'))]);
  assert.ok(a.ok && b.ok && c.ok);
  const record = (await bg.message({ command: 'getQueue', route: 'chat:mychat' })).data;
  assert.deepEqual(record.items.map(q => q.text), ['A','B','C']);
  assert.equal(record.rev, 3);
});
test('actual worker retains sent and queued favorites under simultaneous writes', async () => {
  const bg = createWorker();
  const fav = (text, source) => ({ command: 'favorites', operationId: nextId(), mutation: { type: 'set', text, source, favorite: true } });
  await Promise.all([bg.message(fav('Alpha','queued')), bg.message(fav('Beta','sent')), bg.message(fav('Alpha','sent'))]);
  const result = await bg.message({ command:'getFavorites' });
  assert.equal(result.data.items.length,2);
  assert.deepEqual(Array.from(result.data.items.find(f => f.text === 'Alpha').sources), ['queued','sent']);
});
test('worker migrates v1 records and uncertain messages without replay', async () => {
  const bg = createWorker({
    'qfc_v1_queue_chat:mychat': { version:1,items:[{id:'x',text:'Old queued',status:'awaiting'}] },
    'qfc_v1_favorites': { version:1,items:[{id:'f',text:'Old favorite',sources:['queued','sent']}] }
  });
  const a = await bg.message({command:'getQueue', route:'chat:mychat'});
  const b = await bg.message({command:'getFavorites'});
  assert.equal(a.data.items[0].status,'awaiting');
  assert.equal(b.data.items.length,1);
  assert.equal(bg.db['qfc_v2_queue_chat:mychat'].version,2);
});
test('temporary chat move survives retry and cannot duplicate', async () => {
  const bg = createWorker({ 'qfc_v1_queue_new:tmp123': { items: [{id:'p1',text:'Temporary prompt',status:'pending'}] } });
  const cmd = { command:'moveTemp', source:'new:tmp123', destination:'chat:mychat', operationId:nextId() };
  const first = await bg.message(cmd);
  const second = await bg.message(cmd);
  assert.ok(first.ok && second.ok);
  assert.equal(second.data.items.length,1);
  assert.equal(bg.db['qfc_v2_queue_new:tmp123'].items.length,0);
});
test('unsafe origin cannot invoke coordinator', async () => {
  const bg = createWorker();
  assert.equal(bg.forbidden({command:'getFavorites'}), false);
});

test('temporary chat migration preserves workflow origin and completed preview', async () => {
  const origin = { id: 'flow-1', name: 'Research', step: 1, total: 2 };
  const preview = { id: 'prior', preview: 'Prior completed prompt',
    completedAt: 1000, completion: 'automatic', workflow: origin };
  const bg = createWorker({
    'qfc_v2_queue_new:tmp123': { version: 2, rev: 4, ops: [],
      items: [{ id: 'next', text: 'Next prompt', status: 'pending', workflow: origin }],
      lastCompleted: preview }
  });
  const cmd = { command: 'moveTemp', source: 'new:tmp123', destination: 'chat:mychat',
    operationId: nextId() };
  const first = await bg.message(cmd);
  const retry = await bg.message(cmd);
  assert.ok(first.ok && retry.ok);
  assert.equal(retry.data.items[0].workflow.id, origin.id);
  assert.equal(retry.data.lastCompleted.preview, preview.preview);
  assert.equal((await bg.message({ command: 'getQueue', route: 'chat:mychat' })).data.lastCompleted.workflow.step, 1);
});

test('toolbar and shortcut wake only the selected ChatGPT tab and toggle existing sessions', async () => {
  const bg = createWorker();
  await bg.command('another-command', {id:7,url:'https://chatgpt.com/c/one'});
  assert.equal(bg.injected.length,0);
  await bg.command('toggle-queue-panel', {id:7,url:'https://chatgpt.com/c/one'});
  assert.equal(bg.injected.length,1);
  assert.deepEqual(bg.injected[0],[7,'core.js','content.js']);
  assert.deepEqual(bg.css[0],['insert',7]);
  assert.deepEqual(bg.sent.slice(0,2).map(x=>x.message.action),['status','open-panel']);
  await bg.command('toggle-queue-panel',{id:7,url:'https://chatgpt.com/c/one'});
  assert.equal(bg.injected.length,1);
  assert.equal(bg.sent.at(-1).message.action,'toggle-panel');
  await bg.command('toggle-queue-panel');
  assert.equal(bg.injected[1][0],42);
  await bg.action({id:31,url:'https://chatgpt.com/new'});
  assert.equal(bg.injected[2][0],31);
  await bg.action({id:50,url:'https://example.com/'});
  assert.equal(bg.injected.length,3);
  bg.rejectReceiver();
  await assert.doesNotReject(bg.command('toggle-queue-panel',{id:9,url:'https://chatgpt.com/c/one'}));
  assert.deepEqual(bg.css.at(-1),['remove',9]);
});
