// Perfect-Information Monte Carlo (PIMC) search AI for 升级 / 找朋友.
//
// At a decision point the search:
//   1. enumerates this seat's legal candidate plays (legalCandidatePlays),
//   2. repeatedly DETERMINIZES the hidden state — samples a full assignment of
//      every UNSEEN card to the other seats (and the buried kitty) that is
//      consistent with what this seat has actually observed: its own hand, every
//      card already played, and the kitty it buried if it is the dealer,
//   3. for each candidate, applies it in a clone of that determinized world and
//      plays the round to the end with the existing heuristic as the rollout
//      policy for ALL seats,
//   4. averages a signed outcome (from THIS seat's team view) over all
//      determinizations and returns the best-scoring candidate.
//
// The determinizer IS the AI's "card counter": it reasons over every card that
// has appeared and samples only from the genuinely unseen multiset. That
// advantage lives entirely server-side and is never surfaced to human players.
//
// This is PIMC (a.k.a. determinized rollout / "perfect-information Monte Carlo"):
// simpler than a full ISMCTS tree but strong for trick-taking games, and easy to
// verify against the existing engine. It can be upgraded to a tree search later.

import {
  chooseAiPlay, playCards, runAiStep, legalCandidatePlays, dealerTeamSeats, constants
} from "../game.js";
import {determinizePublicWorld} from './hidden-world.js';

const { PLAYING, ROUND_OVER } = constants.PHASES;

// ── room cloning ───────────────────────────────────────────────────────────
// Card objects are immutable and identified by `.id`, so structuredClone is both
// correct (ids/ranks/suits preserved) and safe. We must first detach the fields
// that hold non-cloneable runtime objects — spectators (Map), clients (Set of
// live sockets), aiTimer / trusteeTimers / kickVote (Timeout handles) — all irrelevant to a
// rollout. CRITICAL: restore them in `finally`, so if structuredClone throws the
// real room isn't left corrupted (that previously nulled room.spectators forever
// and crashed the next broadcast, dropping every player).
function cloneRoom(room) {
  const keys=['spectators','clients','aiTimer','trusteeTimers','kickVote'];
  const detached=keys.map(key=>({key,present:Object.hasOwn(room,key),value:room[key]}));
  for(const {key} of detached)room[key]=undefined;
  let copy;
  try {
    copy = structuredClone(room);
  } finally {
    for(const {key,present,value} of detached)if(present)room[key]=value;else delete room[key];
  }
  copy.spectators = new Map();
  return copy;
}

export { cloneRoom as snapshotSearchRoom };

// ── determinization (the card counter) ─────────────────────────────────────
// Reassigns the hidden cards in `clone` to a world consistent with viewIndex's
// knowledge: its own hand (and the kitty, if it is the dealer) are left intact;
// every other seat's hand and the buried kitty are resampled from the unseen
// pool, preserving each location's card count AND respecting inferred voids.
function determinize(room, viewIndex, clone, rng) {
  return determinizePublicWorld(room,viewIndex,clone,rng);
}

// ── rollout ────────────────────────────────────────────────────────────────
// Drive every seat with the heuristic until the round ends. trickPauseUntil is
// cleared each step so the offline playout never blocks on the display pause.
function makeAllAuto(clone, rolloutLevel, rng) {
  for (const s of clone.seats) {
    s.isAi = true;
    s.trustee = false;
    s.aiLevel = rolloutLevel;
    s.aiBias = 0;
    s.aiRngState = (rng() * 2 ** 31) | 0;
  }
}

function rolloutToEnd(clone) {
  let guard = 0;
  while (clone.phase !== ROUND_OVER && guard++ < 4000) {
    clone.trickPauseUntil = 0;
    if (!runAiStep(clone)) break;
  }
  return clone.phase === ROUND_OVER;
}

// Playing changes hands, triple locks, trick lists, settlement state, and logs.
// The sampled snapshot owns the card objects and completed trick records.
function forkRollout(room) {
  return {
    ...room,
    seats: room.seats.map(seat => ({ ...seat, hand: [...seat.hand], lockedTriples: [...(seat.lockedTriples || [])] })),
    currentTrick: [...room.currentTrick],
    finishedTricks: [...room.finishedTricks],
    friendCall: room.friendCall && { ...room.friendCall },
    scores: { ...room.scores },
    seatPersonalScores: { ...room.seatPersonalScores },
    teamLevels: { ...room.teamLevels },
    tableLog: [],
    matchLog: []
  };
}

function simulateAction(base, viewer, cards, pointWeight, fork = cloneRoom) {
  const world = fork(base);
  world.trickPauseUntil = 0;
  try {
    playCards(world, world.seats[viewer].playerId, cards.map(card => card.id));
    return rolloutToEnd(world) ? pimcOutcome(world, viewer, pointWeight) : null;
  } catch (_) {
    return null;
  }
}

// Compare candidates in the same sampled world. A partial set of outcomes
// cannot be used for a paired comparison.
export function* pimcPairedWorlds(room, viewer, actions, options = {}) {
  if (room.phase !== PLAYING || room.turnSeat !== viewer || !actions.length) {
    throw new Error('Expected candidates for the current turn');
  }
  const snapshot = cloneRoom(room);
  const rng = options.rng ?? Math.random;
  const determinizations = options.determinizations ?? 24;
  const fork = options.deepClone ? cloneRoom : forkRollout;
  for (let i = 0; i < determinizations; i++) {
    const base = fork(snapshot);
    if (!determinize(snapshot, viewer, base, rng)) {
      yield null;
      continue;
    }
    makeAllAuto(base, options.rolloutLevel ?? 'hard', rng);
    const values = actions.map(cards => simulateAction(base, viewer, cards, options.pointWeight, fork));
    yield values.every(Number.isFinite) ? values : null;
  }
}

export function pimcPairedOutcomes(room, viewer, actions, options = {}) {
  return [...pimcPairedWorlds(room, viewer, actions, options)].filter(Boolean);
}

// Signed outcome from the view team's perspective. Primary term = net level
// steps (what winning actually means); fine term = attacker-point margin so the
// search can still rank moves when the level-step outcome ties.
export function pimcOutcome(clone, viewIndex, pointWeight = 1) {
  const viewOnDealer=dealerTeamSeats(clone).includes(viewIndex);
  const res = clone.lastResult?.result;
  const atk = clone.scores?.attackers ?? 0;
  let steps = 0;
  if (res && res.steps > 0) {
    const dealerWon = res.side === "dealer";
    steps = dealerWon === viewOnDealer ? res.steps : -res.steps;
  }
  const pointMargin = viewOnDealer ? -atk : atk;
  return steps * 1000 + pointWeight * pointMargin;
}

// In five-player games allegiance can depend on which occurrence of the called
// card gets played. Each sampled world's terminal friend determines its reward;
// merely holding one copy does not establish the root player's team.
// Legal candidates, optionally capped to a manageable set for search. When
// capping we keep the heuristic's own pick in the comparison, plus the leading
// spread of boss groups. Sampling error can still select a worse move.
function selectCandidates(room, seat, leaderCards, opts) {
  const all = legalCandidatePlays(room, seat, leaderCards);
  const cap = opts.maxCandidates ?? 0;
  if (!cap || all.length <= cap) return all;
  const key = (c) => c.map((x) => x.id).slice().sort().join(",");
  const pick = chooseAiPlay(room, seat, leaderCards);
  const pickKey = pick ? key(pick) : null;
  const head = all.filter((c) => key(c) === pickKey);
  const rest = all.filter((c) => key(c) !== pickKey);
  return [...head, ...rest].slice(0, cap);
}

// ── public entry ───────────────────────────────────────────────────────────
// The search itself is a generator that yields after every determinization (the
// driver resumes it with `true` once the time budget is spent), so the same loop
// can run synchronously (pimcChoosePlay) or cooperatively (pimcChoosePlayAsync).
// Returns the chosen play as an array of card objects, or null if it's not
// viewIndex's turn / not the playing phase.
function* searchPlay(room, viewIndex, opts) {
  if (room.phase !== PLAYING || room.turnSeat !== viewIndex) return null;
  // Candidate generation advances a seat's PRNG. Keep all search mutations in
  // a snapshot, including the synchronous entry point.
  room=cloneRoom(room);
  const maxDeterminizations = opts.determinizations ?? 80;
  const rolloutLevel = opts.rolloutLevel ?? "hard";
  const rng = opts.rng ?? Math.random;

  const seat = room.seats[viewIndex];
  const leaderCards = room.currentTrick[0]?.cards ?? null;
  const candidates = selectCandidates(room, seat, leaderCards, opts);
  if (candidates.length <= 1) return candidates[0] ?? chooseAiPlay(room, seat, leaderCards);

  const totals = new Array(candidates.length).fill(0);
  const counts = new Array(candidates.length).fill(0);

  for (let d = 0; d < maxDeterminizations; d += 1) {
    const base = cloneRoom(room);
    const assigned=determinize(room, viewIndex, base, rng);
    if(assigned)makeAllAuto(base, rolloutLevel, rng);

    for (let ci = 0; assigned && ci < candidates.length; ci += 1) {
      const score = simulateAction(base, viewIndex, candidates[ci]);
      if (score !== null) {
        totals[ci] += score;
        counts[ci] += 1;
      }
    }
    if (d + 1 < maxDeterminizations && (yield)) break; // caller says the budget is spent
  }

  if(!counts.some(Boolean))return chooseAiPlay(room,seat,leaderCards);
  let best = 0;
  let bestAvg = counts[0] ? totals[0] / counts[0] : -Infinity;
  for (let i = 1; i < candidates.length; i += 1) {
    const avg = counts[i] ? totals[i] / counts[i] : -Infinity;
    if (avg > bestAvg) { best = i; bestAvg = avg; }
  }
  return candidates[best];
}

export function pimcChoosePlay(room, viewIndex, opts = {}) {
  const timeBudgetMs = opts.timeBudgetMs ?? 400;
  const start = Date.now();
  const search = searchPlay(room, viewIndex, opts);
  let step = search.next();
  while (!step.done) step = search.next(Date.now() - start >= timeBudgetMs);
  return step.value;
}

// Cooperative variant: awaits `opts.pause()` between determinizations so other
// rooms' messages and timers can run, and so the time budget works on runtimes
// whose clock only advances across I/O (Cloudflare Workers). Searches a snapshot,
// so changes to the live room while paused can't skew the sampling.
export async function pimcChoosePlayAsync(room, viewIndex, opts = {}) {
  const timeBudgetMs = opts.timeBudgetMs ?? 400;
  const pause = opts.pause ?? (() => new Promise((resolve) => setTimeout(resolve, 0)));
  const start = Date.now();
  const search = searchPlay(cloneRoom(room), viewIndex, opts);
  let step = search.next();
  while (!step.done) {
    await pause();
    step = search.next(Date.now() - start >= timeBudgetMs);
  }
  return step.value;
}

// Diagnostics: same search but returns the per-candidate averages (for tuning /
// inspection), without committing to a move.
export function pimcEvaluate(room, viewIndex, opts = {}) {
  room=cloneRoom(room);
  const seat = room.seats[viewIndex];
  const leaderCards = room.currentTrick[0]?.cards ?? null;
  const candidates = legalCandidatePlays(room, seat, leaderCards);
  const rng = opts.rng ?? Math.random;
  const D = opts.determinizations ?? 80;
  const totals = new Array(candidates.length).fill(0);
  const counts = new Array(candidates.length).fill(0);
  for (let d = 0; d < D; d += 1) {
    const base = cloneRoom(room);
    if(!determinize(room, viewIndex, base, rng))continue;
    makeAllAuto(base, opts.rolloutLevel ?? "hard", rng);
    for (let ci = 0; ci < candidates.length; ci += 1) {
      const score = simulateAction(base, viewIndex, candidates[ci]);
      if (score !== null) {
        totals[ci] += score;
        counts[ci] += 1;
      }
    }
  }
  return candidates.map((c, i) => ({
    cards: c.map((x) => x.label),
    avg: counts[i] ? totals[i] / counts[i] : null,
    n: counts[i]
  })).sort((a, b) => (b.avg ?? -Infinity) - (a.avg ?? -Infinity));
}
