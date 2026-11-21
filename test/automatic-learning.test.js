import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {gunzipSync} from 'node:zlib';
import {prepareRoom} from '../bench/learning/environment.mjs';
import {playCards,chooseAiPlay,observeRoomPlays} from '../src/game.js';
import {informationSet} from '../src/ai/learning/observation.js';
import {RoundRecorder} from '../src/ai/learning/recorder.js';
import {AutomaticLearning,atomicJson,sha256} from '../src/ai/learning/automatic.js';
import {promotionGate} from '../bench/learning/promotion.mjs';
import {validateModel} from '../src/ai/learning/network.js';

async function temporary(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'poker-auto-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
function move(room){room.trickPauseUntil=0;const view=informationSet(room,room.turnSeat),s=view.seats[view.viewer];
  const cards=chooseAiPlay(view,s,view.currentTrick[0]?.cards||null);playCards(room,room.seats[room.turnSeat].playerId,cards.map(c=>c.id));}
function finish(room){for(let i=0;i<500&&room.phase==='playing';i++)move(room);assert.equal(room.phase,'roundOver');}

for(const n of [5,6])test(`${n}: recorder writes only completed anonymous human rounds, including forced last moves`,async t=>{
  const directory=await temporary(t),errors=[];
  const recorder=new RoundRecorder({directory,onError:e=>errors.push(e)}),room=prepareRoom(1234,n);
  const ids=room.seats.map(s=>s.playerId);
  room.seats[room.turnSeat].isAi=false;room.seats[0].nickname='PRIVATE_NAME_SENTINEL';
  recorder.attach(room);
  assert.throws(()=>playCards(room,room.seats[room.turnSeat].playerId,['bad-card']));
  move(room);await recorder.flush();assert.equal((await fs.readdir(directory)).length,0);
  finish(room);await recorder.flush();
  assert.deepEqual(errors,[]);
  const files=await fs.readdir(directory);assert.equal(files.length,1);
  const raw=gunzipSync(await fs.readFile(path.join(directory,files[0]))).toString();
  assert.ok(!raw.includes('PRIVATE_NAME_SENTINEL'));for(const id of ids)assert.ok(!raw.includes(id));
  assert.ok(!raw.includes(room.code));
  const data=JSON.parse(raw);assert.equal(data.recordType,'completed-live-round-v1');assert.ok(data.humanActions>0);
  assert.equal(data.samples.length,room.finishedTricks.reduce((s,t)=>s+t.plays.length,0));
  assert.ok(data.samples.some(s=>s.source==='forced'));
  assert.ok(data.samples.every(s=>Number.isFinite(s.reward)&&s.behavior[0]===-1));
});

test('recorder ignores all-AI and partial games; search clones do not invoke observers',async t=>{
  const directory=await temporary(t),recorder=new RoundRecorder({directory});
  const ai=prepareRoom(12,5);recorder.attach(ai);finish(ai);await recorder.flush();
  assert.equal((await fs.readdir(directory)).length,0);
  const room=prepareRoom(18,6);room.seats[room.turnSeat].isAi=false;recorder.attach(room);
  move(structuredClone(room));move(room);await recorder.flush();assert.equal((await fs.readdir(directory)).length,0);
});

test('observer/storage failures cannot interrupt or roll back legal game moves',async t=>{
  const room=prepareRoom(12,5),count=room.seats[room.turnSeat].hand.length;
  observeRoomPlays(room,{before:()=>{throw new Error('expected observer failure');},after:()=>{throw new Error('expected observer failure');}});
  move(room);assert.ok(room.currentTrick.length>0);assert.ok(count>0);
  const directory=await temporary(t),file=path.join(directory,'not-a-directory');await fs.writeFile(file,'x');
  const errors=[],recorder=new RoundRecorder({directory:file,onError:e=>errors.push(e)}),next=prepareRoom(123,6);
  next.seats[next.turnSeat].isAi=false;recorder.attach(next);finish(next);await recorder.flush();assert.ok(errors.length>0);
});

test('promotion requires separate positive evidence in both modes and both baselines',()=>{
  const good={modes:{5:{independentDeals:24,meanNetLevelDelta:.5,standardError:.1},6:{independentDeals:24,meanNetLevelDelta:.5,standardError:.1}}};
  assert.equal(promotionGate({hard:good,incumbent:good}).accepted,true);
  const bad=structuredClone(good);bad.modes[6].meanNetLevelDelta=0;
  assert.equal(promotionGate({hard:good,incumbent:bad}).accepted,false);
  assert.equal(promotionGate({hard:good}).accepted,false);
  const small=structuredClone(good);small.modes[5].independentDeals=2;
  assert.equal(promotionGate({hard:small,incumbent:good}).accepted,false);
});

test('automatic controller waits for complete-round threshold and honors cooldown',async t=>{
  const directory=await temporary(t),controller=new AutomaticLearning({root:process.cwd(),directory,minRounds:20});
  await controller.start({timer:false});t.after(()=>controller.close());
  let status=JSON.parse(await fs.readFile(path.join(directory,'status.json')));
  assert.equal(status.phase,'collecting');assert.equal(status.newCompletedRounds,0);
  controller.state.lastCompleted=Date.now();await controller.tick();
  status=JSON.parse(await fs.readFile(path.join(directory,'status.json')));assert.equal(status.phase,'cooldown');
  assert.equal(controller.state.pending,undefined);
});

test('approved model changes are pinned only on the next round; hash failures keep incumbent',async t=>{
  const directory=await temporary(t),a={name:'old'},controller=new AutomaticLearning({root:process.cwd(),directory,fallbackModel:a});
  await controller.start({timer:false});t.after(()=>controller.close());
  const room={round:1};controller.pin(room);controller.current={name:'new'};
  assert.equal(controller.modelFor(room),a);room.round++;controller.pin(room);assert.equal(controller.modelFor(room).name,'new');
  await atomicJson(path.join(directory,'active.json'),{sha256:'a'.repeat(64)});
  await fs.mkdir(path.join(directory,'models'));await fs.writeFile(path.join(directory,'models','a'.repeat(64)+'.json'),'wrong');
  await assert.rejects(controller.refreshModel(),/hash mismatch/);assert.equal(controller.current.name,'new');
});

test('retention removes only recorder-owned files and preserves unrelated files',async t=>{
  const directory=await temporary(t);await fs.writeFile(path.join(directory,'keep.txt'),'keep');
  for(const name of ['aaaaaaaa','bbbbbbbb','cccccccc'])await fs.writeFile(path.join(directory,name+'.json.gz'),'x');
  await new RoundRecorder({directory,maxRounds:1}).prune();
  const names=await fs.readdir(directory);assert.ok(names.includes('keep.txt'));assert.equal(names.length,2);
});

test('queue launches one worker, persists consumed rounds, and survives controller restart',async t=>{
  const root=await temporary(t),directory=path.join(root,'data');
  await fs.mkdir(path.join(root,'bench/learning'),{recursive:true});
  await fs.writeFile(path.join(root,'bench/learning/automatic-worker.mjs'),`
    import fs from 'node:fs/promises';import path from 'node:path';
    const job=JSON.parse(await fs.readFile(process.argv[2]));
    await fs.appendFile(path.join(job.directory,'launches.txt'),'started\\n');
    await new Promise(r=>setTimeout(r,150));
    await fs.writeFile(path.join(job.runDir,'result.json'),JSON.stringify({ok:true,promoted:false}));
  `);
  await fs.mkdir(path.join(directory,'rounds'),{recursive:true});
  await fs.writeFile(path.join(directory,'rounds','aaaaaaaa.json.gz'),'snapshot-fixture');
  const controller=new AutomaticLearning({root,directory,minRounds:1,cooldownMs:60000});
  await controller.start({timer:false});
  await Promise.all([controller.tick(),controller.tick(),controller.tick()]);
  for(let i=0;i<100&&(!controller.state.lastCompleted||controller.checking);i++)await new Promise(r=>setTimeout(r,20));
  assert.equal(controller.state.processed.length,1);assert.ok(controller.state.lastCompleted);
  assert.equal((await fs.readFile(path.join(directory,'launches.txt'),'utf8')).trim(),'started');
  await controller.close();
  const restarted=new AutomaticLearning({root,directory,minRounds:1,cooldownMs:60000});
  await restarted.start({timer:false});await restarted.close();
  assert.equal(restarted.state.processed.length,1);assert.equal(restarted.state.pending,undefined);
});
