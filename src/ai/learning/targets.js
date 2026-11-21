// Privileged supervision only. Never imported by the policy/observation encoder.
import { counts } from './observation.js';
import { dealerTeamSeats } from '../../game.js';

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
