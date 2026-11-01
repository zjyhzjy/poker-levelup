import { addAiPlayer, callSixTrump, chooseAiPlay, createRoom, decideAiSixTrump, dealerTeamSeats,
  passSixTrump, playCards, runAiStep, startRound, validatePlay } from '../../src/game.js';
import { behaviorClass, counts, decisionInput, informationSet, encodeAction } from '../../src/ai/learning/observation.js';
import { scoreActions } from '../../src/ai/learning/network.js';
import { mulberry32, runAuction, resolveForcedSuit } from '../lib/pimc-deal.mjs';

export {mulberry32};

// Synchronous offline use only: the engine's six-player redeal currently calls
// Math.random internally. Restore it even when a rule error interrupts a deal.
export function withSeed(seed, fn) {
  const original=Math.random;
  Math.random=mulberry32(seed);
  try { return fn(Math.random); } finally { Math.random=original; }
}

export function prepareRoom(seed, seatCount) {
  return withSeed(seed, rng=>{
    if(![5,6].includes(seatCount)) throw new Error('Expected 5 or 6 seats');
    const room=createRoom('OFFLINE',{seatCount});
    for(let i=0;i<seatCount;i++) {
      addAiPlayer(room,i,'hard');
      room.seats[i].aiRngState=(seed*2654435761+i*40503)|0;
      room.seats[i].aiBias=0;
    }
    // Include both opening auctions and continuation ranks in six-player games.
    if(seatCount===6 && rng()<.5) {
      room.round=1;
      const ranks=['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
      room.teamLevels={0:ranks[Math.floor(rng()*13)],1:ranks[Math.floor(rng()*13)]};
      room.nextDealerSeat=Math.floor(rng()*6);
    }
    startRound(room,rng);
    for(let g=0;g<400 && room.phase!=='playing';g++) {
      room.trickPauseUntil=0;
      if(['auction','auctionReady'].includes(room.phase)) runAuction(room);
      else if(room.phase==='forcedSuit') resolveForcedSuit(room);
      else if(room.phase==='sixTrump') {
        const seat=room.seats.find(s=>!room.bidResponses[s.index]);
        if(!seat) throw new Error('No six-player auction responder');
        const bid=decideAiSixTrump(room,seat);
        if(bid) callSixTrump(room,seat.playerId,bid.cardIds);
        else passSixTrump(room,seat.playerId);
      } else if(!runAiStep(room)) throw new Error(`Pre-play stalled in ${room.phase}`);
    }
    if(room.phase!=='playing') throw new Error(`Setup failed: ${seed}/${seatCount}/${room.phase}`);
    return room;
  });
}

// Simulator-only labels. This function is never imported by the inference code.
export function privilegedTargets(room, viewer) {
  const belief=[], beliefMask=[];
  for(let r=0;r<6;r++) {
    const valid=r>0 && r<room.seatCount;
    belief.push(...(valid?counts(room.seats[(viewer+r)%room.seatCount].hand).map(v=>v/3):Array(54).fill(0)));
    beliefMask.push(...Array(54).fill(Number(valid)));
  }
  const unknownKitty=viewer!==room.dealerSeat;
  belief.push(...(unknownKitty?counts(room.hiddenKitty).map(v=>v/3):Array(54).fill(0)));
  beliefMask.push(...Array(54).fill(Number(unknownKitty)));
  return {belief,beliefMask};
}

export function terminalReward(room, viewer) {
  if(room.phase!=='roundOver') throw new Error('Reward requested before terminal state');
  const result=room.lastResult.result;
  const dealerNet=result.side==='dealer'?result.steps:result.side==='attackers'?-result.steps:0;
  return (dealerTeamSeats(room).includes(viewer)?dealerNet:-dealerNet)/3;
}

export function playEpisode({seed,seatCount,policies,model=null,epsilon=0,sampleRate=0,collect=false}) {
  return withSeed(seed^0x5f3759df,rng=>{
    const room=prepareRoom(seed,seatCount), samples=[], moves=[];
    let latencyMs=0, learnedMoves=0;
    for(let turn=0;room.phase!=='roundOver'&&turn<1000;turn++) {
      if(room.phase!=='playing') throw new Error(`Unexpected phase ${room.phase}`);
      room.trickPauseUntil=0;
      const viewer=room.turnSeat, seat=room.seats[viewer], policy=policies[viewer];
      const keep=collect && rng()<sampleRate;
      let input=null, cards;
      if(keep||policy==='learned'||policy==='random') input=decisionInput(room,viewer);
      if(policy==='learned'&&model) {
        const start=performance.now();
        const values=scoreActions(model,input.observation,input.features);
        const index=rng()<epsilon?Math.floor(rng()*values.length):values.indexOf(Math.max(...values));
        cards=input.actions[index]; latencyMs+=performance.now()-start; learnedMoves++;
      } else if(policy==='random') cards=input.actions[Math.floor(rng()*input.actions.length)];
      else {
        const view=input?.view||informationSet(room,viewer);
        view.seats[viewer].aiLevel=policy==='easy'?'easy':'hard';
        view.seats[viewer].aiRngState=(seed+turn*7919+viewer*40503)|0;
        cards=chooseAiPlay(view,view.seats[viewer],view.currentTrick[0]?.cards||null);
      }
      if(!validatePlay(room,seat,cards,room.currentTrick[0]?.cards||null).ok) throw new Error(`Illegal action ${seed}/${seatCount}/${viewer}`);
      const view=input?.view||informationSet(room,viewer);
      if(keep) {
        // Recompute features for an actual heuristic move if it wasn't in the bounded set.
        samples.push({observation:input.observation,action:encodeAction(view,cards),
          ...privilegedTargets(room,viewer),viewer,move: moves.length,seatCount,episodeSeed:seed});
      }
      moves.push({seat:viewer,category:behaviorClass(view,cards,room.currentTrick[0]?.cards||[])});
      playCards(room,seat.playerId,cards.map(c=>c.id));
    }
    if(room.phase!=='roundOver') throw new Error(`Game exceeded step limit: ${seed}/${seatCount}`);
    for(const sample of samples) {
      sample.reward=terminalReward(room,sample.viewer);
      sample.behavior=Array(6).fill(-1);
      for(let j=sample.move+1;j<moves.length;j++) {
        const relative=(moves[j].seat-sample.viewer+seatCount)%seatCount;
        if(relative!==0&&sample.behavior[relative]===-1) sample.behavior[relative]=moves[j].category;
      }
      delete sample.viewer; delete sample.move;
    }
    return {seed,seatCount,samples,rewards:room.seats.map(s=>terminalReward(room,s.index)),
      moves:moves.length,latencyMs,learnedMoves,friendSeat:room.friendSeat,dealerSeat:room.dealerSeat};
  });
}
