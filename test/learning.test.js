import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareRoom,playEpisode,privilegedTargets,terminalReward,withSeed} from '../bench/learning/environment.mjs';
import {ACTION_SIZE,OBSERVATION_SIZE,SCHEMA,decisionInput,informationSet,encodeObservation,counts} from '../src/ai/learning/observation.js';
import {scoreActions,validateModel,chooseLearnedPlay} from '../src/ai/learning/network.js';
import {validatePlay,chooseAiPlay,playCards} from '../src/game.js';
import {evaluate} from '../bench/learning/evaluate.mjs';

function zeroModel() {
  const matrix=(r,c)=>Array.from({length:r},()=>Array(c).fill(0));
  return validateModel({schema:SCHEMA,observationSize:OBSERVATION_SIZE,actionSize:ACTION_SIZE,seatCounts:[5,6],hiddenSize:2,actionHiddenSize:2,
    encoderW:matrix(2,OBSERVATION_SIZE),encoderB:[0,0],qW:matrix(2,2+ACTION_SIZE),qB:[0,0],
    valueW:matrix(1,2),valueB:[0],beliefW:matrix(378,2),beliefB:Array(378).fill(0),behaviorW:matrix(48,2),behaviorB:Array(48).fill(0)});
}

for(const n of [5,6]) {
  test(`${n} players: hidden-information isolation holds in midgame`,()=>{
    const room=prepareRoom(9981,n);
    for(let turn=0;turn<30&&room.phase==='playing';turn++) {
      const viewer=room.turnSeat,before=decisionInput(room,viewer);
      const changed=structuredClone(room),others=changed.seats.filter(s=>s.index!==viewer);
      if(others[0].hand.length&&others[1].hand.length)
        [others[0].hand[0],others[1].hand[0]]=[others[1].hand[0],others[0].hand[0]];
      const after=decisionInput(changed,viewer);
      assert.deepEqual(after.observation,before.observation);
      assert.deepEqual(after.features,before.features);
      const cards=chooseAiPlay(before.view,before.view.seats[viewer],before.view.currentTrick[0]?.cards||null);
      room.trickPauseUntil=0;
      playCards(room,room.seats[viewer].playerId,cards.map(c=>c.id));
    }
  });
  test(`${n} players: encoding and candidates cannot depend on hidden hand identities`,()=>{
    const room=prepareRoom(1121,n),viewer=room.turnSeat;
    const before=decisionInput(room,viewer), model=zeroModel();
    const hidden=room.seats.filter(s=>s.index!==viewer);
    const changed=structuredClone(room);
    // Redistribute every other hand, preserving all publicly visible hand sizes.
    const pool=hidden.flatMap(s=>s.hand).reverse();let offset=0;
    for(const seat of changed.seats)if(seat.index!==viewer){seat.hand=pool.slice(offset,offset+seat.hand.length);offset+=seat.hand.length;}
    const after=decisionInput(changed,viewer);
    assert.deepEqual(after.observation,before.observation);
    assert.deepEqual(after.features,before.features);
    assert.deepEqual(scoreActions(model,after.observation,after.features),scoreActions(model,before.observation,before.features));
    assert.deepEqual(chooseLearnedPlay(changed,viewer,model),chooseLearnedPlay(room,viewer,model));
    for(const a of before.actions) assert.equal(validatePlay(room,room.seats[viewer],a,null).ok,true);
    assert.equal(before.observation.length,OBSERVATION_SIZE);
    assert.ok(before.features.every(a=>a.length===ACTION_SIZE));
  });

  test(`${n} players: other hands are never read beyond their public length`,()=>{
    const room=prepareRoom(1121,n),viewer=room.turnSeat;
    const baseline=decisionInput(room,viewer);
    for(const seat of room.seats)if(seat.index!==viewer) {
      const length=seat.hand.length;
      seat.hand=new Proxy([],{get(_t,k){if(k==='length')return length;throw new Error(`Private hand read: ${String(k)}`);}});
    }
    assert.deepEqual(decisionInput(room,viewer).observation,baseline.observation);
  });

  test(`${n} players: unknown kitty is hidden; dealer has only its own extra knowledge`,()=>{
    const room=prepareRoom(1121,n),other=(room.dealerSeat+1)%n;
    const baseline=encodeObservation(informationSet(room,other));
    const changed=structuredClone(room);
    const swap=(room.dealerSeat+2)%n;
    [changed.hiddenKitty[0],changed.seats[swap].hand[0]]=[changed.seats[swap].hand[0],changed.hiddenKitty[0]];
    assert.deepEqual(encodeObservation(informationSet(changed,other)),baseline);
    assert.deepEqual(informationSet(room,other).hiddenKitty,[]);
    assert.deepEqual(counts(informationSet(room,room.dealerSeat).hiddenKitty),counts(room.hiddenKitty));
    const view=informationSet(room,other);
    assert.equal(view.lastResult,undefined);
    assert.equal(view.tableLog,undefined);
    assert.equal(view.deck,undefined);
    view.seats[other].hand.length=0;
    assert.ok(room.seats[other].hand.length>0,'detached view must not mutate live room');
  });

  test(`${n} players: seeded self-play finishes and produces isolated, finite training labels`,()=>{
    const args={seed:1121,seatCount:n,policies:Array(n).fill('hard'),sampleRate:.1,collect:true};
    const a=playEpisode(args),b=playEpisode(args);
    assert.deepEqual(a.samples,b.samples);
    assert.deepEqual(a.rewards,b.rewards);
    assert.ok(a.samples.length>0);
    for(const row of a.samples) {
      assert.equal(row.belief.length,378);
      assert.equal(row.behavior.length,6);
      assert.ok(row.belief.slice(0,54).every(x=>x===0));
      assert.ok(row.beliefMask.slice(0,54).every(x=>x===0));
      if(n===5)assert.ok(row.beliefMask.slice(270,324).every(x=>x===0));
      assert.equal(row.behavior[0],-1);
      assert.ok(Number.isFinite(row.reward));
      assert.ok(row.observation.every(Number.isFinite));
      assert.equal(row.observation.belief,undefined);
    }
  });

  test(`${n} players: experimental learned policy plays a complete legal game`,()=>{
    const result=playEpisode({seed:7919,seatCount:n,policies:Array(n).fill('learned'),model:zeroModel()});
    assert.ok(result.moves>0);
    assert.equal(result.rewards.length,n);
  });
}

test('five-player reward uses actual terminal friend, not guessed pre-reveal allegiance',()=>{
  const room={phase:'roundOver',mode:'findFriend5',dealerSeat:0,friendSeat:3,lastResult:{result:{side:'dealer',steps:2}}};
  assert.equal(terminalReward(room,3),2/3);
  assert.equal(terminalReward(room,1),-2/3);
});

test('random override is restored after failed offline simulation',()=>{
  const original=Math.random;
  assert.throws(()=>withSeed(3,()=>{throw new Error('expected');}));
  assert.equal(Math.random,original);
});

test('model loading rejects wrong schema, missing mode and non-finite weights',()=>{
  let model=zeroModel();model.schema='wrong';assert.throws(()=>validateModel(model));
  model=zeroModel();model.seatCounts=[5];assert.throws(()=>validateModel(model));
  model=zeroModel();model.encoderW[0][0]=NaN;assert.throws(()=>validateModel(model));
});

test('evaluation rejects training seed overlap and identical-policy control has exactly zero edge',()=>{
  const model=zeroModel();model.metadata={trainingSeeds:[123]};
  assert.throws(()=>evaluate({model,seeds:2,seed:123}),/used in training/);
  const report=evaluate({model,seeds:2,seed:1000000001,candidatePolicy:'hard'});
  for(const n of [5,6]) {
    assert.equal(report.modes[n].meanNetLevelDelta,0);
    assert.equal(report.modes[n].standardError,0);
  }
});
