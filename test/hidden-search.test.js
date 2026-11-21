import test from 'node:test';
import assert from 'node:assert/strict';
import {assignConstrainedCards,determinizePublicWorld,publicVoids} from '../src/ai/hidden-world.js';
import {pimcChoosePlay,pimcOutcome} from '../src/ai/pimc.js';
import {prepareRoom,mulberry32,withSeed} from '../bench/learning/environment.mjs';
import {informationSet} from '../src/ai/learning/observation.js';
import {chooseAiPlay,playCards,playSuit,validatePlay,createRoom,addAiPlayer,startRound,runAiStep,
  decideAiSixTrump,callSixTrump,passSixTrump} from '../src/game.js';
import {runAuction,resolveForcedSuit} from '../bench/lib/pimc-deal.mjs';
import {createDeck} from '../src/cards.js';

function canAssign(masks,needs,index=0) {
  if(index===masks.length)return needs.every(n=>n===0);
  for(let j=0;j<needs.length;j++)if(needs[j]&&(masks[index]&(1<<j))) {
    needs[j]--;const yes=canAssign(masks,needs,index+1);needs[j]++;if(yes)return true;
  }
  return false;
}

test('constrained sampler agrees with exhaustive feasibility on small deals',()=>{
  const rng=mulberry32(11072026);
  for(let trial=0;trial<240;trial++) {
    const n=2+Math.floor(rng()*3),needs=Array.from({length:n},()=>1+Math.floor(rng()*2));
    const masks=Array.from({length:needs.reduce((a,b)=>a+b,0)},()=>1+Math.floor(rng()*((1<<n)-1)));
    const pool=masks.map((mask,id)=>({id,mask})),targets=needs.map((need,index)=>({need,index}));
    const result=assignConstrainedCards(pool,targets,c=>c.mask,rng);
    assert.equal(Boolean(result),canAssign(masks,[...needs]),JSON.stringify({masks,needs}));
    if(result)for(const [i,slot] of result.entries()) {
      assert.equal(slot.cards.length,needs[i]);assert.ok(slot.cards.every(c=>c.mask&(1<<i)));
    }
  }
});

test('constrained sampler never discards an impossible ownership constraint',()=>{
  assert.equal(assignConstrainedCards([{id:0},{id:1}],[{need:1},{need:1}],()=>1),null);
  assert.equal(assignConstrainedCards([{id:0}],[{need:1}],()=>0),null);
});

test('five-player sampled reward follows terminal friend, not possession of a called card',()=>{
  const room={mode:'findFriend5',seats:Array.from({length:5},(_,index)=>({index})),dealerSeat:0,friendSeat:2,
    scores:{attackers:40},lastResult:{result:{side:'dealer',steps:2}}};
  assert.equal(pimcOutcome(room,1),-1960);
  assert.equal(pimcOutcome(room,2),1960);
  room.friendSeat=1;assert.equal(pimcOutcome(room,1),1960);
});

test('classic four-player search retains legal sampling and leaves the room unchanged',()=>withSeed(12345,()=>{
  const room=createRoom('SEARCH4',{seatCount:4});
  for(let i=0;i<4;i++)addAiPlayer(room,i,'hard');
  startRound(room,mulberry32(12345));
  for(let guard=0;room.phase!=='playing'&&guard<100;guard++) {
    if(['dealing','auction','auctionReady'].includes(room.phase))runAuction(room);
    else if(room.phase==='forcedSuit')resolveForcedSuit(room);
    else if(room.phase==='sixTrump') {
      const seat=room.seats.find(s=>!room.bidResponses[s.index]),bid=decideAiSixTrump(room,seat);
      if(bid)callSixTrump(room,seat.playerId,bid.cardIds);else passSixTrump(room,seat.playerId);
    }
    else assert.ok(runAiStep(room));
  }
  assert.equal(room.phase,'playing');
  const viewer=room.turnSeat,before=structuredClone(room);
  assert.ok(determinizePublicWorld(room,viewer,structuredClone(room),mulberry32(345)));
  const cards=pimcChoosePlay(room,viewer,{determinizations:2,maxCandidates:2,timeBudgetMs:Infinity,rng:mulberry32(345)});
  assert.ok(validatePlay(room,room.seats[viewer],cards,null).ok);
  assert.deepEqual(room,before);
}));

for(const n of [5,6]) {
  test(`${n} players: sampled worlds preserve counts, public voids and exposed dealer cards`,()=>{
    const room=prepareRoom(9981,n);
    for(let turn=0;turn<45&&room.phase==='playing';turn++) {
      if(turn%9===0) {
        const viewer=room.turnSeat,voids=publicVoids(room,viewer);
        for(let sample=0;sample<6;sample++) {
          const world=determinizePublicWorld(room,viewer,structuredClone(room),mulberry32(700+sample));
          assert.ok(world,'a real history must have a feasible void/count assignment');
          assert.deepEqual(world.seats[viewer].hand,room.seats[viewer].hand);
          if(viewer===room.dealerSeat)assert.deepEqual(world.hiddenKitty,room.hiddenKitty);
          for(const s of world.seats) {
            assert.equal(s.hand.length,room.seats[s.index].hand.length);
            if(s.index!==viewer)assert.ok(s.hand.every(c=>!voids[s.index].has(playSuit(c,room))));
          }
          const played=[...world.finishedTricks.flatMap(t=>t.plays),...world.currentTrick].flatMap(p=>p.cards);
          const all=[...world.seats.flatMap(s=>s.hand),...world.hiddenKitty,...played];
          assert.equal(new Set(all.map(c=>c.id)).size,createDeck(room.deckCopies).length);
          for(const c of room.revealedKitty||[]) {
            const matches=x=>x.rank===c.rank&&x.suit===c.suit;
            const dealerPlayed=[...room.finishedTricks.flatMap(t=>t.plays),...room.currentTrick]
              .filter(p=>p.seat===room.dealerSeat).flatMap(p=>p.cards).filter(matches).length;
            const remaining=[...world.seats[room.dealerSeat].hand,...world.hiddenKitty].filter(matches).length;
            assert.ok(remaining>=Math.max(0,room.revealedKitty.filter(matches).length-dealerPlayed));
          }
        }
      }
      const view=informationSet(room,room.turnSeat),cards=chooseAiPlay(view,view.seats[view.viewer],view.currentTrick[0]?.cards||null);
      room.trickPauseUntil=0;playCards(room,room.seats[room.turnSeat].playerId,cards.map(c=>c.id));
    }
  });

  test(`${n} players: sampled worlds and decisions ignore real hidden cards and private locks`,()=>{
    const room=prepareRoom(4401,n);
    for(let turn=0;turn<19;turn++) {
      const view=informationSet(room,room.turnSeat),cards=chooseAiPlay(view,view.seats[view.viewer],view.currentTrick[0]?.cards||null);
      room.trickPauseUntil=0;playCards(room,room.seats[room.turnSeat].playerId,cards.map(c=>c.id));
    }
    const viewer=room.turnSeat,changed=structuredClone(room),pool=changed.seats.filter(s=>s.index!==viewer).flatMap(s=>s.hand).reverse();let offset=0;
    for(const s of changed.seats)if(s.index!==viewer) {
      const length=s.hand.length;s.hand=pool.slice(offset,offset+length);offset+=length;
      s.lockedTriples=['A|hearts','K|clubs'];
    }
    const a=determinizePublicWorld(room,viewer,structuredClone(room),mulberry32(887));
    const b=determinizePublicWorld(changed,viewer,structuredClone(changed),mulberry32(887));
    assert.ok(a&&b);
    assert.deepEqual(a.seats.map(s=>({hand:s.hand,locked:s.lockedTriples})),b.seats.map(s=>({hand:s.hand,locked:s.lockedTriples})));
    const options={determinizations:2,maxCandidates:2,timeBudgetMs:Infinity,rolloutLevel:'hard'};
    const before=structuredClone(room);
    const pick=pimcChoosePlay(room,viewer,{...options,rng:mulberry32(334)});
    const other=pimcChoosePlay(changed,viewer,{...options,rng:mulberry32(334)});
    assert.deepEqual(pick.map(c=>c.id),other.map(c=>c.id));
    assert.deepEqual(room,before,'candidate generation and snapshots must not change live state');
    assert.ok(validatePlay(room,room.seats[viewer],pick,room.currentTrick[0]?.cards||null).ok);
  });

  test(`${n} players: public bid inference cannot identify physical copies of identical faces`,()=>{
    const room=prepareRoom(4401,n),viewer=(room.dealerSeat+1)%n,changed=structuredClone(room);
    for(const b of [...Object.values(changed.seatBids||{}),changed.currentBid].filter(Boolean)) {
      b.cards=(b.cards||[]).map(c=>({...c,id:'opaque-public-'+c.rank+'-'+c.suit}));
    }
    const a=determinizePublicWorld(room,viewer,structuredClone(room),mulberry32(809));
    const b=determinizePublicWorld(changed,viewer,structuredClone(changed),mulberry32(809));
    assert.ok(a&&b);assert.deepEqual(a.seats.map(s=>s.hand),b.seats.map(s=>s.hand));
    assert.deepEqual(a.hiddenKitty,b.hiddenKitty);
  });
}
