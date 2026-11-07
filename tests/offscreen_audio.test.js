'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

function player() {
  const contexts=[];
  const timers=new Map();
  let timerId=0, messageListener, pagehide;
  class AudioContextMock {
    constructor(){this.currentTime=0;this.destination={};this.oscillators=[];this.closed=false;contexts.push(this);}
    createOscillator(){
      const node={
        frequency:{setValueAtTime(){}},type:'',stopped:false,
        connect(){},disconnect(){},start(){},
        stop(){this.stopped=true;}
      };
      this.oscillators.push(node);
      return node;
    }
    createGain(){
      return {gain:{setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){}},
        connect(){}};
    }
    resume(){return Promise.resolve();}
    close(){this.closed=true;return Promise.resolve();}
  }
  const ctx=vm.createContext({
    chrome:{runtime:{id:'unit-audio',onMessage:{addListener(fn){messageListener=fn;}}}},
    window:{AudioContext:AudioContextMock,addEventListener(event,fn){
      if(event==='pagehide')pagehide=fn;
    }},
    setTimeout(fn,ms){const id=++timerId;timers.set(id,{fn,ms});return id;},
    clearTimeout(id){timers.delete(id);},
    console
  });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../offscreen.js'),'utf8'),ctx);
  return {
    contexts,timers,
    play(sound,duration,ext='unit-audio'){
      let response;
      const handled=messageListener({app:'qfc-audio-v1',action:'play',sound,duration},
        {id:ext},r=>{response=r;});
      return {handled,response};
    },
    expire(){for(const [id,t] of [...timers]){timers.delete(id);t.fn();}},
    hide(){pagehide();}
  };
}

test('offscreen audio creates original tones and stops after bounded duration',()=>{
  const p=player();
  assert.equal(p.play('soft','once').response.played,true);
  assert.equal(p.contexts.length,1);
  assert.equal(p.contexts[0].oscillators.length,2);
  const firstTimer=[...p.timers.values()][0];
  assert.ok(firstTimer.ms<1000 && firstTimer.ms>0);
  p.expire();
  assert.equal(p.contexts[0].closed,true);
  assert.ok(p.contexts[0].oscillators.every(osc=>osc.stopped));
  assert.equal(p.timers.size,0);
  assert.equal(p.play('alert','20').response.played,true);
  assert.ok([...p.timers.values()][0].ms<=20150);
  assert.ok(p.contexts[1].oscillators.length>3);
  p.hide();
  assert.equal(p.contexts[1].closed,true);
  assert.equal(p.timers.size,0);
});

test('a new sound cancels the old sound without overlapping players',()=>{
  const p=player();
  assert.equal(p.play('double','10').response.played,true);
  assert.equal(p.play('soft','5').response.played,true);
  assert.equal(p.contexts.length,2);
  assert.equal(p.contexts[0].closed,true);
  assert.equal(p.timers.size,1);
  p.expire();
  assert.equal(p.contexts[1].closed,true);
});

test('offscreen audio rejects unauthorized messages and invalid duration or sound',()=>{
  const p=player();
  assert.equal(p.play('soft','5','foreign-extension').handled,false);
  assert.equal(p.play('soft','500').response.played,false);
  assert.equal(p.play('external-file','5').response.played,false);
  assert.equal(p.contexts.length,0);
  assert.equal(p.timers.size,0);
});
