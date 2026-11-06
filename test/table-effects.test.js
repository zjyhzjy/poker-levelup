import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {collectTableEvents,createTableEffects} from '../public/table-effects.js';
import {createRoom,publicState} from '../src/game.js';

const card=(id,suit='hearts',rank='A')=>({id,suit,rank});
const play=(seat,type='single',extra={})=>({seat,cards:[card(`c${seat}`)],shape:{type,...extra}});
const state=(extra={})=>({code:'FX',round:1,phase:'playing',currentTrick:[],lastTrick:[],lastTrickWin:null,
  trumpKillSeats:[],lastTrickKillSeats:[],dealerSeat:0,friendSeat:null,viewerSeat:0,seatCount:5,...extra});
const kinds=(room,prev)=>collectTableEvents(room,prev).map(e=>e.kind);

test('first state, reconnect, new round and repeated broadcasts do not replay effects',()=>{
  const room=state({currentTrick:[play(0,'tractor',{unit:2,count:2})]});
  assert.deepEqual(kinds(room,null),[]);
  assert.deepEqual(kinds(room,room),[]);
  assert.deepEqual(kinds({...room,code:'OTHER'},room),[]);
  assert.deepEqual(kinds({...room,round:2},room),[]);
  assert.deepEqual(kinds(room,state()),['tractor']);
  assert.deepEqual(kinds({...room,lastTrickWin:{seq:1}},state({lastTrickWin:{seq:2}})),[]);
});

test('the final play of a trick is detected without replaying its earlier tractor',()=>{
  const lead=play(0,'tractor',{unit:3,count:2}),last=play(4,'tractor',{unit:3,count:2});
  const before=state({currentTrick:[lead,play(1),play(2),play(3)]});
  const after=state({lastTrick:[...before.currentTrick,last],lastTrickWin:{seq:1,winner:4,points:10}});
  const events=collectTableEvents(after,before);
  assert.equal(events.length,1);assert.equal(events[0].kind,'tractor');
  assert.equal(events[0].title,'三条拖拉机');assert.match(events[0].key,/:4:4:/);
});

test('failed throws show one penalty despite capped logs; kept triples do not fire twice',()=>{
  const throwResult={seat:0,failed:true,allCards:[card('a'),card('b')],keepCards:[card('a')]};
  const room=state({throwResult,currentTrick:[play(0,'triple')],tableLog:Array(40).fill('same-size log')});
  const events=collectTableEvents(room,state({tableLog:Array(40).fill('older log')}));
  assert.deepEqual(events.map(e=>e.kind),['throw-fail']);assert.equal(events[0].tag,'−10 分');
  assert.deepEqual(kinds(room,structuredClone(room)),[]);
  assert.deepEqual(kinds(state({currentTrick:[play(0,'throw')]}),state()),['throw']);
});

test('only server-validated kills explode, and overkill requires taking the lead',()=>{
  const before=state({currentTrick:[play(0)]});
  const after=state({currentTrick:[play(0),play(1)],trumpKillSeats:[1],currentWinnerSeat:1});
  assert.deepEqual(kinds(after,before),['bomb']);
  assert.deepEqual(kinds({...after,trumpKillSeats:[]},before),[]);
  const next={...after,currentTrick:[...after.currentTrick,play(2)],trumpKillSeats:[1,2],currentWinnerSeat:2};
  assert.deepEqual(kinds(next,after),['overkill']);
  assert.deepEqual(kinds({...next,currentWinnerSeat:1},after),[]);
});

for(const seatCount of [4,5,6])test(`${seatCount}: legal kill metadata survives trick completion in public state`,()=>{
  const room=createRoom('FXPUB',{seatCount});room.phase='playing';room.levelRank='2';room.trumpSuit='spades';
  room.lastTrick=[{...play(0),cards:[card('lead','hearts','A')]},
    {...play(1),cards:[card('kill','spades','3')]}];
  room.lastTrickWin={seq:1,winner:1,points:10};
  const view=publicState(room);
  assert.deepEqual(view.lastTrickKillSeats,[1]);
  assert.deepEqual(kinds(view,{...view,lastTrickWin:null,lastTrick:[],currentTrick:[room.lastTrick[0]]}),['bomb']);
});

test('round celebrations use actual team outcome, including fixed-team hold with zero upgrades',()=>{
  const end=state({phase:'roundOver',fixedTeams:true,seatCount:6,viewerSeat:2,
    lastResult:{result:{side:'dealer',steps:0,label:'庄家守庄'},upgradedSeats:[]}});
  assert.equal(collectTableEvents(end,state())[0].kind,'victory');
  assert.equal(collectTableEvents({...end,viewerSeat:1},state())[0].kind,'defeat');
  assert.equal(collectTableEvents({...end,viewerSeat:null},state())[0].kind,'finish');
  assert.equal(collectTableEvents({...end,seatCount:5,fixedTeams:false,friendSeat:3,viewerSeat:3},state())[0].kind,'victory');
  assert.deepEqual(kinds(end,end),[]);
});

test('high-point captures and successful triple leads have their own cues',()=>{
  assert.deepEqual(kinds(state({currentTrick:[play(0,'triple')]}),state()),['triple']);
  assert.deepEqual(kinds(state({lastTrickWin:{seq:1,winner:0,points:50}}),state()),['harvest']);
});

function renderer({reduced=false,coarse=false}={}) {
  const timers=new Map(),sounds=[],saved=new Map();let nextId=0;
  class Element {
    constructor(){this.children=[];this.style={setProperty(){}};this.attributes={};}
    setAttribute(key,value){this.attributes[key]=value;}
    appendChild(child){child.parent=this;this.children.push(child);}
    remove(){if(this.parent)this.parent.children=this.parent.children.filter(c=>c!==this);}
  }
  const root=new Element(),doc={hidden:false,createElement:()=>new Element(),querySelector:()=>root};
  const win={localStorage:{getItem:key=>saved.get(key),setItem:(key,value)=>saved.set(key,value)},
    matchMedia:query=>({matches:query.includes('reduced-motion')?reduced:coarse}),
    setTimeout:(fn,ms)=>{const id=++nextId;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id)};
  const fx=createTableEffects({document:doc,window:win,sound:name=>sounds.push(name)});
  const tick=()=>{const first=timers.entries().next().value;if(first){timers.delete(first[0]);first[1].fn();}};
  return {fx,root,doc,window:win,timers,sounds,saved,tick};
}

test('effects stay bounded during a burst, auto-clean and deduplicate sounds',()=>{
  const r=renderer();
  r.fx.play({kind:'bomb',key:'same',title:'毙了'});r.fx.play({kind:'bomb',key:'same',title:'毙了'});
  assert.equal(r.sounds.length,1);assert.equal(r.root.children.length,1);
  assert.equal(r.root.children[0].attributes['aria-hidden'],'true');
  assert.equal(r.root.children[0].children.filter(c=>c.className==='fx-spark').length,20);
  for(let i=0;i<20;i++)r.fx.play({kind:'tractor',key:`burst-${i}`,title:'拖拉机'});
  assert.equal(r.timers.size,1);
  for(let i=0;i<4;i++)r.tick();
  assert.equal(r.sounds.length,3);assert.equal(r.root.children.length,0);assert.equal(r.timers.size,0);
});

test('reduced motion uses a compact cue; off and hidden states clear scenes and timers',()=>{
  const r=renderer({reduced:true});r.fx.play({kind:'throw-fail',title:'甩牌失败'});
  assert.match(r.root.children[0].className,/fx-lite/);
  assert.equal(r.root.children[0].children.filter(c=>c.className==='fx-spark').length,0);
  assert.equal([...r.timers.values()][0].ms,700);
  r.fx.setMode('off');assert.equal(r.root.children.length,0);assert.equal(r.timers.size,0);
  assert.equal(r.saved.get('szp.effects'),'off');r.fx.play({kind:'bomb'});assert.equal(r.root.children.length,0);
  r.fx.setMode('full');r.doc.hidden=true;r.fx.update(state());
  r.fx.update(state({currentTrick:[play(0,'tractor')]}));assert.equal(r.root.children.length,0);
  r.doc.hidden=false;r.fx.update(state({currentTrick:[play(0,'tractor')]}));assert.equal(r.root.children.length,0);
});

test('untrusted text is emitted as text, and stale state cannot rewind the event cursor',()=>{
  const r=renderer({coarse:true}),text='<img src=x onerror=alert(1)>';
  r.fx.play({kind:'bomb',title:text});
  const scene=r.root.children[0];assert.ok(!scene.innerHTML.includes(text));
  assert.equal(scene.children[0].children[0].textContent,text);
  assert.equal(scene.children.filter(c=>c.className==='fx-spark').length,12);
  r.fx.reset();r.fx.update(state({lastTrickWin:{seq:2}}));
  r.fx.update(state({lastTrickWin:{seq:1}}));
  r.fx.update(state({lastTrickWin:{seq:2}}));assert.equal(r.root.children.length,0);
});

test('photographic sprites warm once in full mode and are real RGBA assets',async()=>{
  const r=renderer(),loaded=[];
  r.window.Image=class {set src(value){loaded.push(value);}};
  r.fx.update(state({phase:'lobby'}));r.fx.update(state({phase:'lobby'}));
  assert.equal(loaded.length,4);assert.equal(new Set(loaded).size,4);
  for(const url of loaded){
    const bytes=await fs.readFile(new URL(`../public${url}`,import.meta.url));
    assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
    assert.equal(bytes[25],6,'RGBA PNG retains generated transparency');
    assert.ok(bytes.readUInt32BE(16)<=2048&&bytes.readUInt32BE(20)<=2048);
  }
});

test('lightweight, reduced-motion and hidden pages do not preload photographic sprites',()=>{
  for(const mode of ['lite','off','reduced','hidden']){
    const r=renderer({reduced:mode==='reduced'}),loaded=[];
    r.window.Image=class {set src(value){loaded.push(value);}};
    if(['lite','off'].includes(mode))r.fx.setMode(mode);
    if(mode==='hidden')r.doc.hidden=true;
    r.fx.update(state({phase:'lobby'}));assert.equal(loaded.length,0,mode);
  }
});
