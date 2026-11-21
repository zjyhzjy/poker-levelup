import { createDeck, RANKS, SUITS } from '../../src/cards.js';
import { createRoom, observeRoomPlays, playCards, sortHand } from '../../src/game.js';
import { encodeAction, encodeObservation, faceIndex, informationSet, SCHEMA } from '../../src/ai/learning/observation.js';
import { privilegedTargets, terminalReward } from '../../src/ai/learning/targets.js';

const FACE_COUNT = 54;
const deck = createDeck(3);
const byFace = Array.from({ length: FACE_COUNT }, (_, i) => [deck[i], deck[i + 54], deck[i + 108]]);
const sameVector = (actual, expected) => actual.length === expected?.length &&
  actual.every((value, i) => value === expected[i]);

function cardsFor(encoded, groups) {
  return encoded.flatMap((value, i) => {
    const count = Math.round(value * 3);
    if (count < 0 || count > groups[i].length || count / 3 !== value) {
      throw new Error('Recorded face count cannot be assigned');
    }
    return groups[i].splice(0, count);
  });
}

function publicCardFaces(observation, offset) {
  return cardsFor(observation.slice(offset, offset + FACE_COUNT), byFace.map(group => [...group]));
}

function initialRoom(record) {
  const first = record.samples[0];
  const x = first.observation;
  if (x[0] !== 0 || x[1] !== 1 || x[20] !== 1 || x[90] !== 0) {
    throw new Error('Replay must begin at the first six-player dealer move');
  }
  const room = createRoom('OFFLINE', { seatCount: 6 });
  const levelRank = RANKS[x.slice(2, 15).indexOf(1)];
  const trumpIndex = x.slice(15, 20).indexOf(1);
  if (!levelRank || trumpIndex < 0) throw new Error('Missing recorded trump settings');
  Object.assign(room, {
    phase: 'playing', round: 1, dealerSeat: 0, currentLeader: 0, turnSeat: 0,
    levelRank, trumpSuit: SUITS[trumpIndex] ?? null, noTrump: trumpIndex === 4,
    teamLevels: { 0: levelRank, 1: '2' }
  });
  const available = byFace.map(group => [...group]);
  for (const seat of room.seats) {
    const hand = seat.index === 0 ? x.slice(91, 145)
      : first.belief.slice(seat.index * FACE_COUNT, (seat.index + 1) * FACE_COUNT);
    seat.hand = cardsFor(hand, available);
    seat.playerId = `offline-${seat.index}`;
    seat.level = room.teamLevels[seat.index % 2];
    sortHand(seat.hand, room);
  }
  room.hiddenKitty = cardsFor(x.slice(145, 199), available);
  if (room.hiddenKitty.length !== 6 || room.seats.some(seat => seat.hand.length !== 26) ||
      available.some(group => group.length)) throw new Error('Initial replay cards do not account for the deck');
  const bidder = x.slice(727, 733).indexOf(1);
  if (bidder >= 0) room.currentBid = { seat: bidder, cards: publicCardFaces(x, 673) };
  room.revealedKitty = publicCardFaces(x, 960);
  return room;
}

// Existing v1 records save face counts and the accepted action sequence. Make
// interchangeable copies of each face and verify every reconstructed state
// against the original tensors before using any reconstructed positions.
export function replayLiveSix(record, onPosition = () => {}) {
  if (record.schema !== SCHEMA || record.recordType !== 'completed-live-round-v1' ||
      record.seatCount !== 6 || !record.samples?.length || record.samples.length > 200) {
    throw new Error('Expected a completed six-player v1 recording');
  }
  const room = initialRoom(record);
  const dealerPool = [...room.seats[0].hand, ...room.hiddenKitty];
  const kitty = [...room.hiddenKitty];
  const viewers = [];
  let error;
  observeRoomPlays(room, {
    before(current, seat, ids, forced) {
      if (error) return;
      const row = record.samples[viewers.length];
      try {
        const view = informationSet(current, seat.index);
        const cards = ids.map(id => seat.hand.find(card => card.id === id));
        const labels = privilegedTargets(current, seat.index);
        if (!row || row.seatCount !== 6 || forced !== (row.source === 'forced') ||
            !sameVector(encodeObservation(view), row.observation) ||
            !sameVector(encodeAction(view, cards), row.action) ||
            !sameVector(labels.belief, row.belief) || !sameVector(labels.beliefMask, row.beliefMask)) {
          throw new Error('Reconstructed move differs from v1 recording');
        }
        viewers.push(seat.index);
        onPosition(current, seat.index, row, viewers.length - 1);
      } catch (cause) {
        error = new Error(`Replay validation failed at move ${viewers.length + 1}`, { cause });
      }
    }
  });
  try {
    while (room.phase === 'playing' && viewers.length < record.samples.length) {
      const row = record.samples[viewers.length];
      if (row.source === 'forced') throw new Error('Missing automatic follow in replay');
      const seat = room.seats[room.turnSeat];
      const groups = Array.from({ length: FACE_COUNT }, () => []);
      for (const card of seat.hand) groups[faceIndex(card)].push(card);
      const cards = cardsFor(row.action.slice(0, FACE_COUNT), groups);
      room.trickPauseUntil = 0;
      playCards(room, seat.playerId, cards.map(card => card.id));
      if (error) throw error;
    }
  } finally {
    observeRoomPlays(room, null);
  }
  if (room.phase !== 'roundOver' || viewers.length !== record.samples.length ||
      viewers.some((viewer, i) => terminalReward(room, viewer) !== record.samples[i].reward)) {
    throw new Error('Replay settlement differs from recording');
  }
  return { room, dealerPool, kitty };
}
