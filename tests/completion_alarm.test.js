'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const alarmSource = source.slice(source.indexOf('  const ALARM_KEY ='), source.indexOf('  const IDLE_SLEEP_SCALE_MS ='));
assert.ok(alarmSource.includes('function armManualAlarm'));
function harness() {
  const factory = new Function(alarmSource + `
    const state = { running: false };
    let disposed = false, disposing = false, runnerPromise = null, root = null;
    const C = { normalize: x => String(x ?? '').trim() };
    let clock = 0, seq = 0, sounds = 0, closes = 0, observer = null;
    const timers = new Map(), transientTimers = new Set();
    const setTimeout = (fn, delay) => { const id = ++seq; timers.set(id, {fn, at: clock + delay}); return id; };
    const clearTimeout = id => timers.delete(id);
    const Date = { now: () => clock };
    const location = { pathname: '/c/one' };
    const document = { body: {} };
    const model = { draft:'prompt', receipt:false, generating:false, reply:null, actions:false, editor:true, disabled:false };
    const findEditor = () => model.editor ? {} : null;
    const composerArea = editor => editor ? {} : null;
    const editorText = editor => editor ? model.draft : '';
    const findSendButton = () => ({disabled:model.disabled, getAttribute:()=>null});
    const isGenerating = () => model.generating;
    const assistantMessages = () => model.reply ? [model.reply] : [];
    const assistantText = reply => reply.text;
    const assistantHasCompletedActions = () => model.actions;
    const currentRoute = () => location.pathname.startsWith('/c/') ? location.pathname : null;
    const snapshotUserTurns = () => ({});
    const hasNewUserReceipt = () => model.receipt && !model.draft;
    const scheduleIdleSleep = () => {};
    class MutationObserver {
      constructor(fn) { this.fn = fn; this.active = false; observer = this; }
      observe() { this.active = true; }
      disconnect() { this.active = false; }
    }
    class AudioContext {
      constructor() { sounds++; this.currentTime=0; this.destination={}; }
      createOscillator() { return {frequency:{},connect(){},start(){},stop(){}}; }
      createGain() { return {gain:{setValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){}}; }
      resume() { return Promise.resolve(); }
      close() { closes++; return Promise.resolve(); }
    }
    const window = {AudioContext};
    function advance(ms) {
      const end = clock + ms;
      while (true) {
        const next = [...timers.entries()].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];
        if (!next) break;
        clock=next[1].at; timers.delete(next[0]); next[1].fn();
      }
      clock=end;
    }
    function mutate() {
      if (observer?.active) observer.fn([{target:{nodeType:1,closest:()=>null}}]);
      advance(150);
    }
    return {model,location,state,advance,mutate,arm:armManualAlarm,enable:applyAlarmSetting,
      cancel:clearManualAlarm,beep:playCompletionAlarm, stats:()=>({sounds,closes,active:!!manualAlarm,observing:!!observer?.active,timers:timers.size})};
  `);
  return factory();
}
function sent(h) {
  h.model.draft = ''; h.model.receipt = true; h.model.generating = true; h.mutate();
}
function reply(h) {
  h.model.generating = false; h.model.reply = {text:'answer'}; h.mutate();
}
test('off by default: no manual monitoring or audio', () => {
  const h=harness(); h.arm(); h.beep(); assert.equal(h.stats().active,false); assert.equal(h.stats().sounds,0);
});
test('disabled send does not arm; unsent attempt expires', () => {
  const h=harness(); h.enable(true); h.model.disabled=true; h.arm(); assert.equal(h.stats().active,false);
  h.model.disabled=false; h.arm(); assert.equal(h.stats().active,true); h.advance(15000);
  assert.equal(h.stats().active,false); assert.equal(h.stats().timers,0);
});
test('manual completion survives editor replacement and waits for late controls', () => {
  const h=harness(); h.enable(true); h.arm(); sent(h);
  h.model.editor=false; h.mutate(); h.model.editor=true; reply(h);
  h.advance(1800); assert.equal(h.stats().sounds,0);
  h.model.actions=true; h.mutate(); assert.equal(h.stats().sounds,1);
  assert.equal(h.stats().observing,false); h.advance(2000); assert.equal(h.stats().closes,1);
  assert.equal(h.stats().timers,0);
});
test('unstable output restarts settle interval', () => {
  const h=harness(); h.enable(true); h.arm(); sent(h); reply(h); h.model.actions=true;
  h.advance(1000); h.model.reply.text='changed'; h.mutate();
  h.advance(1000); assert.equal(h.stats().sounds,0); h.advance(700); assert.equal(h.stats().sounds,1);
});
test('cancel, disable, queue start and route change stay silent', () => {
  for(const action of [h=>h.cancel(),h=>h.enable(false),h=>{h.state.running=true},h=>{h.location.pathname='/c/two'}]) {
    const h=harness(); h.enable(true); h.arm(); sent(h); action(h); reply(h);
    h.model.actions=true; h.mutate(); h.advance(2000); assert.equal(h.stats().sounds,0); assert.equal(h.stats().active,false);
  }
});
test('no user receipt means no alarm even with a new assistant response', () => {
  const h=harness(); h.enable(true); h.arm(); reply(h); h.model.actions=true; h.mutate(); h.advance(15000);
  assert.equal(h.stats().sounds,0); assert.equal(h.stats().active,false);
});
test('new chat handoff retains receipt, then rejects another conversation', () => {
  const h=harness(); h.location.pathname='/'; h.enable(true); h.arm(); h.location.pathname='/c/new'; sent(h);
  h.location.pathname='/c/other'; reply(h); h.model.actions=true; h.mutate(); h.advance(2000);
  assert.equal(h.stats().sounds,0); assert.equal(h.stats().active,false);
});
test('queued alarm avoids overlapping contexts and closes when disabled', () => {
  const h=harness(); h.enable(true); h.beep(); h.beep(); assert.equal(h.stats().sounds,1);
  h.enable(false); assert.equal(h.stats().closes,1); h.advance(2000); assert.equal(h.stats().closes,1);
});
