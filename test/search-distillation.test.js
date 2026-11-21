import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareRoom, mulberry32 } from '../bench/learning/environment.mjs';
import { chooseAiPlay, playCards, validatePlay } from '../src/game.js';
import { informationSet } from '../src/ai/learning/observation.js';
import { validateModel, chooseLearnedPlay } from '../src/ai/learning/network.js';
import { pimcPairedOutcomes } from '../src/ai/pimc.js';
import { searchPolicyInput, SEARCH_POLICY_SCHEMA, SEARCH_FEATURE_SIZE, SEARCH_HAND_LIMIT } from '../src/ai/search-policy.js';

for (const n of [5, 6]) {
  test(`${n}-player student uses public features and pairs the teacher's worlds`, async () => {
    const room = prepareRoom(9981, n);
    const model = validateModel({ schema: SEARCH_POLICY_SCHEMA, featureSize: SEARCH_FEATURE_SIZE,
      handLimit: SEARCH_HAND_LIMIT, seatCounts: [n], models: {
        [n]: { kind: 'linear', margin: 0, coefficients: Array(SEARCH_FEATURE_SIZE).fill(0) }
      } });
    assert.equal(chooseLearnedPlay(room, room.turnSeat, model), null);
    const full = validateModel({ ...model, models: { [n]: {
      ...model.models[n], opening: { ...model.models[n] }
    } } });
    const first = chooseLearnedPlay(room, room.turnSeat, full);
    assert.ok(first?.length && validatePlay(room, room.seats[room.turnSeat], first, null).ok);

    let input;
    let checkedExtendedHand = false;
    for (let turn = 0; room.phase === 'playing' && turn < 200; turn++) {
      const viewer = room.turnSeat;
      const seat = room.seats[viewer];
      if (!checkedExtendedHand && n === 6 && seat.hand.length <= 12 && seat.hand.length > SEARCH_HAND_LIMIT) {
        const expanded = validateModel({ ...model, handLimit: 12, models: { [n]: { ...model.models[n], handLimit: 12 } } });
        assert.equal(chooseLearnedPlay(room, viewer, model), null);
        const cards = chooseLearnedPlay(room, viewer, expanded);
        assert.ok(validatePlay(room, seat, cards, room.currentTrick[0]?.cards || null).ok);
        checkedExtendedHand = true;
      }
      if (seat.hand.length <= SEARCH_HAND_LIMIT) {
        const decision = searchPolicyInput(room, viewer);
        if (decision.actions.length > 1) {
          input = decision;
          break;
        }
      }
      const view = informationSet(room, viewer);
      const cards = chooseAiPlay(view, view.seats[viewer], view.currentTrick[0]?.cards || null);
      room.trickPauseUntil = 0;
      playCards(room, room.seats[viewer].playerId, cards.map(card => card.id));
    }
    if (n === 6) assert.ok(checkedExtendedHand);
    assert.ok(input, 'Expected a late decision with alternatives');
    assert.ok(input.features.every(row => row.length === SEARCH_FEATURE_SIZE && row.every(Number.isFinite)));
    const viewer = room.turnSeat;
    const changed = structuredClone(room);
    const others = changed.seats.filter(seat => seat.index !== viewer);
    const pool = others.flatMap(seat => seat.hand).reverse();
    let offset = 0;
    for (const seat of others) {
      seat.hand = pool.slice(offset, offset + seat.hand.length);
      offset += seat.hand.length;
      seat.lockedTriples = ['A|hearts'];
    }
    assert.deepEqual(searchPolicyInput(changed, viewer), input);
    const before = structuredClone(room);
    const sameAction = [input.actions[0], input.actions[0]];
    const options = { determinizations: 3, rng: mulberry32(273) };
    const outcomes = pimcPairedOutcomes(room, viewer, sameAction, options);
    assert.ok(outcomes.length >= 2);
    assert.ok(outcomes.every(row => row[0] === row[1]));
    assert.deepEqual(pimcPairedOutcomes(changed, viewer, sameAction, { ...options, rng: mulberry32(273) }), outcomes);
    const pick = chooseLearnedPlay(room, viewer, model);
    assert.deepEqual(pick, input.actions[0]);
    assert.ok(validatePlay(room, room.seats[viewer], pick, room.currentTrick[0]?.cards || null).ok);

    const forked = pimcPairedOutcomes(room, viewer, input.actions, { determinizations: 3, rng: mulberry32(812) });
    const deep = pimcPairedOutcomes(room, viewer, input.actions, { determinizations: 3, rng: mulberry32(812), deepClone: true });
    assert.ok(deep.length >= 2);
    assert.deepEqual(forked, deep);
    model.models[n].search = { worlds: 5, probeWorlds: 1, candidates: 2,
      priorWorlds: 3, confidence: .5, pointWeight: .5, rolloutLevel: 'master' };
    validateModel(model);
    const sync = chooseLearnedPlay(room, viewer, model, { rng: mulberry32(589) });
    let pauses = 0;
    const cooperative = await chooseLearnedPlay(room, viewer, model, {
      rng: mulberry32(589), pause: async () => { pauses++; }, timeBudgetMs: Infinity
    });
    assert.ok(pauses > 0);
    assert.deepEqual(cooperative, sync);
    const interrupted = await chooseLearnedPlay(room, viewer, model, {
      rng: mulberry32(589), pause: async () => {}, timeBudgetMs: 0
    });
    assert.deepEqual(interrupted, pick);
    const changingRoom = structuredClone(room);
    const snapshotPick = await chooseLearnedPlay(changingRoom, viewer, model, {
      rng: mulberry32(589), pause: async () => { changingRoom.phase = 'roundOver'; }
    });
    assert.deepEqual(snapshotPick, sync);
    assert.ok(validatePlay(room, room.seats[viewer], sync, room.currentTrick[0]?.cards || null).ok);
    assert.deepEqual(chooseLearnedPlay(changed, viewer, model, { rng: mulberry32(589) }), sync);
    assert.deepEqual(room, before);
  });
}
