import test from 'node:test';
import assert from 'node:assert/strict';
import {configureHub, createApiRoom, connectClient, receiveMessage, disconnectClient} from '../src/hub.js';
import {prepareRoom} from '../bench/learning/environment.mjs';
import {chooseAiPlay} from '../src/game.js';
import {informationSet} from '../src/ai/learning/observation.js';

for (const seatCount of [5, 6]) {
  test(`${seatCount} players: hub attaches collection, pins each start and invokes host policy`, async t => {
    t.mock.timers.enable({apis:['setTimeout']});
    const attached=[], pinned=[], messages=[];
    let choices=0;
    configureHub({
      store:{read:()=>null,write:()=>{},remove:()=>{},list:()=>[]},
      searchOpts:{master:{determinizations:1,maxCandidates:1,timeBudgetMs:1}},
      learning:{
        attach:room=>attached.push(room),
        pin:room=>pinned.push(room.round),
        choosePlay:(room, viewer)=>{
          choices++;
          const view=informationSet(room,viewer);
          return chooseAiPlay(view,view.seats[viewer],view.currentTrick[0]?.cards||null);
        }
      }
    });
    const code=createApiRoom(seatCount), room=attached.at(-1);
    assert.equal(room.code,code);
    assert.equal(room.seatCount,seatCount);
    const client=connectClient({send:text=>messages.push(JSON.parse(text)),close:()=>{}});
    const send=(type,payload={})=>receiveMessage(client,JSON.stringify({type,payload}));
    try {
      send('joinRoom',{code,nickname:'Integration check'});
      send('sit',{seatIndex:0});
      for(let i=1;i<seatCount;i++)send('addAi',{seatIndex:i,level:'easy'});
      send('startRound');
      assert.deepEqual(pinned,[room.round]);
      assert.equal(messages.filter(m=>m.type==='error').length,0);
      t.mock.timers.reset();
      t.mock.timers.enable({apis:['setTimeout']});
      const ready=prepareRoom(8765,seatCount);
      const clients=room.clients;
      Object.assign(room,ready,{code,clients,aiTimer:null,trickPauseUntil:0});
      const actor=room.seats[room.turnSeat];
      actor.aiLevel='master';
      const initialCards=actor.hand.length;
      send('reconnect',{code,playerId:room.seats[(room.turnSeat+1)%seatCount].playerId});
      t.mock.timers.tick(350);
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(choices,1);
      assert.ok(actor.hand.length<initialCards);
      // A WebSocket-created room must also attach collection.
      send('createRoom',{seatCount,nickname:'Integration check'});
      assert.equal(attached.length,2);
    } finally {
      disconnectClient(client);
      configureHub({learning:null});
      t.mock.timers.reset();
    }
  });
}
