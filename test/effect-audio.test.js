import test from 'node:test';
import assert from 'node:assert/strict';

test('procedural impact sounds honor mute and FX volume, without requesting missing clips',async t=>{
  const originals={window:globalThis.window,localStorage:globalThis.localStorage,Audio:globalThis.Audio};
  t.after(()=>{for(const [key,value]of Object.entries(originals))value===undefined?delete globalThis[key]:globalThis[key]=value;});
  const nodes=[],times=[],param=()=>({value:0,setValueAtTime(){},exponentialRampToValueAtTime(){},
    linearRampToValueAtTime(){},setTargetAtTime(){},cancelScheduledValues(){}});
  const node=()=>{const n={gain:param(),frequency:param(),detune:param(),connect(){},
    start:time=>times.push(time),stop:time=>times.push(time)};nodes.push(n);return n;};
  class AudioContext {
    constructor(){this.currentTime=12;this.sampleRate=1000;this.state='running';this.destination={};}
    createGain(){return node();}createOscillator(){return node();}createBufferSource(){return node();}
    createBiquadFilter(){return node();}createBuffer(_n,size){return {getChannelData:()=>new Float32Array(size)};}
  }
  let clipRequests=0;
  globalThis.window={AudioContext};
  globalThis.localStorage={getItem:()=>null,setItem(){}};
  globalThis.Audio=class {constructor(){clipRequests++;throw new Error('Unexpected clip lookup');}};
  const audio=await import('../public/audio.js');
  audio.sfx('bomb');assert.equal(nodes.length,0,'default muted');
  audio.toggleVoice();
  for(const name of ['tractor','bomb','throw-fail','throw-success','triple','celebrate'])audio.sfx(name);
  assert.ok(nodes.length>20);assert.equal(clipRequests,0);
  assert.ok(times.every(time=>Number.isFinite(time)&&time>=12));
  audio.setFxVol(0);const before=nodes.length;audio.sfx('bomb');assert.equal(nodes.length,before);
  audio.toggleVoice();audio.setFxVol(.5);audio.sfx('celebrate');assert.equal(nodes.length,before);
});
