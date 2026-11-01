// The only boundary at which the learned policy may see a live room.
// All downstream code receives this detached, explicitly allow-listed view.
import { RANKS, SUITS, cardScore, createDeck } from '../../cards.js';
import { analyzeShape, cardOrderValue, determineTrickWinner, legalCandidatePlays, playSuit } from '../../game.js';

export const SCHEMA = 'shengji-information-set-v1';
export const SHAPES = ['single', 'pair', 'triple', 'tractor', 'throw', 'empty'];
export const BEHAVIORS = ['low-single', 'high-single', 'trump-single', 'ruff', 'pair', 'triple', 'tractor', 'throw'];
export const FACES = createDeck(1).map(({rank, suit}) => ({rank, suit}));
const FACE_INDEX = new Map(FACES.map((c, i) => [`${c.suit}:${c.rank}`, i]));
export const faceIndex = c => FACE_INDEX.get(`${c.suit}:${c.rank}`);
export function counts(cards = []) {
  const out = Array(54).fill(0);
  for (const card of cards) { const i = faceIndex(card); if (i === undefined) throw new Error('Unknown card face'); out[i]++; }
  return out;
}
const clone = value => structuredClone(value);
const oneHot = (index, n) => Array.from({length:n}, (_, i) => Number(i === index));
const relative = (seat, viewer, n) => seat == null ? -1 : (seat - viewer + n) % n;

export function informationSet(room, viewer) {
  if (![5, 6].includes(room.seatCount)) throw new Error('Learned AI supports only 5 or 6 seats');
  if (!Number.isInteger(viewer) || !room.seats[viewer]) throw new Error('Invalid viewer');
  const view = {};
  for (const key of ['mode', 'phase', 'seatCount', 'deckCopies', 'kittySize', 'fixedTeams',
    'levelRank', 'trumpSuit', 'noTrump', 'dealerSeat', 'friendSeat', 'friendCall',
    'currentLeader', 'turnSeat', 'currentTrick', 'finishedTricks', 'scores',
    'currentBid', 'seatBids', 'revealedKitty']) view[key] = clone(room[key]);
  view.viewer = viewer;
  // No other player's ID, random state, private locked triples, hand or server log.
  view.seats = room.seats.map(s => ({index:s.index, level:s.level, handCount:s.hand.length,
    takenTrickPoints:s.takenTrickPoints || 0, aiLevel:'hard', aiBias:0, aiRngState:1,
    hand:s.index === viewer ? clone(s.hand) : [],
    lockedTriples:s.index === viewer ? clone(s.lockedTriples || []) : []}));
  // Dealer already knows the cards they buried. Everyone else gets only a count.
  view.hiddenKitty = viewer === room.dealerSeat ? clone(room.hiddenKitty) : [];
  view.hiddenKittyCount = room.hiddenKitty.length;
  // Bid card identities are public, but player identity strings are unnecessary.
  if (view.currentBid) delete view.currentBid.playerId;
  return view;
}

export function publicEvents(view) {
  return [...view.finishedTricks.flatMap(t => t.plays.map((p, i) => ({...p, lead:t.plays[0].cards, first:i === 0}))),
    ...view.currentTrick.map((p, i) => ({...p, lead:view.currentTrick[0].cards, first:i === 0}))];
}

export function voidSuits(view) {
  const out = Array.from({length:view.seatCount}, () => new Set());
  for (const e of publicEvents(view)) {
    if (e.first) continue;
    const suit = playSuit(e.lead[0], view);
    if (e.cards.filter(c => playSuit(c, view) === suit).length < e.lead.length) out[e.seat].add(suit);
  }
  return out;
}

export function behaviorClass(view, cards, lead = []) {
  const shape = analyzeShape(cards, view).type;
  if (shape === 'throw') return 7;
  if (shape === 'tractor') return 6;
  if (shape === 'triple') return 5;
  if (shape === 'pair') return 4;
  if (lead.length && playSuit(lead[0], view) !== 'trump' && cards.every(c => playSuit(c, view) === 'trump')) return 3;
  if (cards.every(c => playSuit(c, view) === 'trump')) return 2;
  return cards.some(c => ['A','K','Q','J'].includes(c.rank)) ? 1 : 0;
}

export function encodeObservation(view) {
  const n = view.seatCount, me = view.viewer, rel = s => relative(s, me, n);
  const own = counts(view.seats[me].hand), kitty = counts(view.hiddenKitty);
  const events = publicEvents(view), voids = voidSuits(view);
  const played = counts(events.flatMap(e => e.cards));
  const unknown = own.map((x, i) => Math.max(0, view.deckCopies - x - played[i] - kitty[i]));
  const call = view.friendCall;
  const x = [Number(n === 5), Number(n === 6), ...oneHot(RANKS.indexOf(view.levelRank), 13),
    ...oneHot(view.noTrump ? 4 : SUITS.indexOf(view.trumpSuit), 5),
    ...oneHot(rel(view.dealerSeat), 6), ...oneHot(rel(view.friendSeat), 6),
    ...oneHot(call ? faceIndex(call) : -1, 54), (call?.ordinal || 0)/3, (call?.seen || 0)/3,
    view.scores.attackers/300, view.scores.dealerTeam/300, events.length/162,
    ...own.map(v => v/3), ...kitty.map(v => v/3), ...unknown.map(v => v/3)];
  for (let r = 0; r < 6; r++) {
    if (r >= n) { x.push(...Array(70).fill(0)); continue; }
    const s = (me + r) % n, history = events.filter(e => e.seat === s);
    const style = Array(8).fill(0);
    for (const e of history) style[behaviorClass(view, e.cards, e.first ? [] : e.lead)]++;
    x.push(1, view.seats[s].handCount/33, view.seats[s].takenTrickPoints/300,
      ...[...SUITS,'trump'].map(suit => Number(voids[s].has(suit))),
      ...counts(history.flatMap(e => e.cards)).map(v => v/3),
      ...style.map(v => v/Math.max(1, history.length)));
  }
  x.push(...counts(view.currentBid?.cards || []).map(v => v/3), ...oneHot(rel(view.currentBid?.seat), 6));
  const recent = events.slice(-8);
  x.push(...Array((8-recent.length)*20).fill(0));
  for (const e of recent) x.push(...oneHot(rel(e.seat), 6),
    ...oneHot([...SUITS,'trump'].indexOf(playSuit(e.cards[0], view)), 5),
    ...oneHot(SHAPES.indexOf(analyzeShape(e.cards, view).type), 6),
    e.cards.length/33, e.cards.reduce((s,c) => s+cardScore(c), 0)/100, Number(e.first));
  x.push(...oneHot(rel(view.currentLeader), 6), ...counts(view.currentTrick.flatMap(p => p.cards)).map(v => v/3),
    ...oneHot(view.currentTrick.length ? rel(determineTrickWinner(view, view.currentTrick)) : -1, 6),
    view.currentTrick.length/6, ...counts(view.revealedKitty).map(v => v/3));
  if (x.length !== OBSERVATION_SIZE || x.some(v => !Number.isFinite(v))) throw new Error('Invalid observation encoding');
  return x;
}

export function encodeAction(view, cards) {
  const shape = analyzeShape(cards, view), suits = [...SUITS,'trump'];
  const play = {seat:view.viewer, cards, shape, points:cards.reduce((s,c)=>s+cardScore(c),0)};
  const ids = new Set(cards.map(c => c.id));
  const remaining = view.seats[view.viewer].hand.filter(c => !ids.has(c.id));
  return [...counts(cards).map(v=>v/3), ...suits.map(s=>cards.filter(c=>playSuit(c,view)===s).length/cards.length),
    ...oneHot(SHAPES.indexOf(shape.type),6), cards.length/33, play.points/100,
    Math.max(...cards.map(c=>cardOrderValue(c,view)))/1000,
    Number(determineTrickWinner(view,[...view.currentTrick,play]) === view.viewer),
    ...suits.map(s=>remaining.filter(c=>playSuit(c,view)===s).length/33)];
}

export function decisionInput(room, viewer) {
  const view = informationSet(room, viewer);
  if (view.phase !== 'playing' || view.turnSeat !== viewer) throw new Error('Not this player\'s turn');
  // Candidate generation runs on the sanitized view too: no side channel via legal actions.
  const actions = legalCandidatePlays(view, view.seats[viewer], view.currentTrick[0]?.cards || null);
  if (!actions.length) throw new Error('No legal candidate');
  return {view, observation:encodeObservation(view), actions, features:actions.map(a=>encodeAction(view,a))};
}

export const OBSERVATION_SIZE = 1014;
export const ACTION_SIZE = 74;
