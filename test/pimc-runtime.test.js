import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareRoom, mulberry32} from '../bench/learning/environment.mjs';
import {pimcChoosePlay, pimcChoosePlayAsync} from '../src/ai/pimc.js';
import {validatePlay} from '../src/game.js';

for (const seatCount of [5, 6]) {
  test(`${seatCount} players: async PIMC works with a live AI timer and preserves room state`, async () => {
    const room=prepareRoom(1234,seatCount), viewer=room.turnSeat;
    const before=structuredClone(room);
    const options={determinizations:2,maxCandidates:2,timeBudgetMs:Infinity,rolloutLevel:'hard'};
    const expected=pimcChoosePlay(before,viewer,{...options,rng:mulberry32(987)});
    const timer=setTimeout(()=>{},10000);
    room.aiTimer=timer;
    const clients=new Set([{send:()=>{}}]);
    room.clients=clients;
    let pauses=0;
    try {
      const actual=await pimcChoosePlayAsync(room,viewer,{...options,rng:mulberry32(987),
        pause:async ()=>{pauses++;}});
      assert.deepEqual(actual.map(c=>c.id),expected.map(c=>c.id));
      assert.equal(validatePlay(room,room.seats[viewer],actual,null).ok,true);
      assert.ok(pauses>0,'Search must run rather than fall back before sampling');
      assert.equal(room.aiTimer,timer);
      assert.equal(room.clients,clients);
      assert.deepEqual(room.seats.map(s=>s.hand),before.seats.map(s=>s.hand));
      assert.equal(room.turnSeat,viewer);
    } finally {
      clearTimeout(timer);
    }
  });
}
