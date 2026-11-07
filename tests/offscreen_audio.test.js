'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

function player(options={}) {
  const contexts=[];
  const timers=new Map();
  let timerId=0, messageListener, pagehide;
  class AudioContextMock {
    constructor(){this.currentTime=0;this.destination={};this.oscillators=[];this.gains=[];this.closed=false;contexts.push(this);}
    createOscillator(){
      const node={
        frequency:{setValueAtTime(){}},type:'',stopped:false,disconnected:false,
        start(when){this.startAt=when;}, stop(when){this.stopped=true;this.stopAt=when;},
        connect(){},disconnect(){this.disconnected=true;}
      };
      this.oscillators.push(node);
      return node;
    }
    createGain(){
      const events=[];
      const node={events,disconnected:false,gain:{
        setValueAtTime(v,t){events.push(['set',v,t]);},
        linearRampToValueAtTime(v,t){events.push(['linear',v,t]);},
        exponentialRampToValueAtTime(v,t){events.push(['exp',v,t]);}
      },connect(){},disconnect(){this.disconnected=true;}};
      this.gains.push(node);
      return node;
    }
    resume(){return options.rejectResume ? Promise.reject(new Error('blocked')) : Promise.resolve();}
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
  function send(message,ext='unit-audio') {
    let response;
    const handled=messageListener({app:'qfc-audio-v1',...message},
      {id:ext},r=>{response=r;});
    return {handled,response};
  }
  return {
    contexts,timers,
    play(sound,duration,volume=75,ext='unit-audio'){
      return send({action:'play',sound,duration,volume},ext);
    },
    stop(){return send({action:'stop'});},
    expire(){for(const [id,t] of [...timers]){timers.delete(id);t.fn();}},
    hide(){pagehide();}
  };
}

test('offscreen playback has fixed audio-node count even for 60-second alerts',()=>{
  const p=player();
  assert.equal(p.play('soft','once').response.played,true);
  assert.equal(p.contexts[0].oscillators.length,2);
  assert.equal(p.contexts[0].gains.length,2);
  assert.ok([...p.timers.values()][0].ms<1000);
  p.expire();
  assert.equal(p.contexts[0].closed,true);
  assert.ok(p.contexts[0].gains.every(g=>g.disconnected));
  assert.equal(p.timers.size,0);
  assert.equal(p.play('alert','60',100).response.played,true);
  const long=p.contexts[1];
  assert.equal(long.oscillators.length,1);
  assert.equal(long.gains.length,1);
  assert.ok(long.gains[0].events.length>150);
  assert.ok([...p.timers.values()][0].ms<=60200);
  assert.equal(p.timers.size,1,'no recurring audio timer');
  assert.equal(long.gains[0].events.find(e=>e[0]==='linear')[1],0.15);
  p.hide();
  assert.equal(long.closed,true);
  assert.equal(p.timers.size,0);
});

test('new sound replaces earlier playback and stop explicitly closes context',()=>{
  const p=player();
  assert.equal(p.play('double','10').response.played,true);
  assert.equal(p.play('soft','5').response.played,true);
  assert.equal(p.contexts.length,2);
  assert.equal(p.contexts[0].closed,true);
  assert.equal(p.timers.size,1);
  assert.equal(p.stop().response.stopped,true);
  assert.equal(p.contexts[1].closed,true);
  assert.equal(p.timers.size,0);
  assert.equal(p.stop().response.stopped,true);
});

test('offscreen audio rejects untrusted requests, invalid durations and volume',()=>{
  const p=player();
  assert.equal(p.play('soft','5',75,'foreign-extension').handled,false);
  for(const duration of ['0','61','01','1.5','500',5,null]) {
    assert.equal(p.play('soft',duration).response.played,false);
  }
  for(const volume of [-1,101,75.5,'75',0]) {
    assert.equal(p.play('soft','5',volume).response.played,false);
  }
  assert.equal(p.play('external-file','5').response.played,false);
  assert.equal(p.contexts.length,0);
  assert.equal(p.timers.size,0);
});

test('audio resume failure closes resources without leaving a timer',async()=>{
  const p=player({rejectResume:true});
  assert.equal(p.play('soft','2').response.played,true,'scheduling acknowledged');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(p.contexts[0].closed,true);
  assert.equal(p.timers.size,0);
});
