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

import { createDeck, shuffle } from "../cards.js";
import {
  chooseAiPlay, playCards, runAiStep, legalCandidatePlays, playSuit, constants
} from "../game.js";

const { PLAYING, ROUND_OVER } = constants.PHASES;

// ── room cloning ───────────────────────────────────────────────────────────
// Card objects are immutable and identified by `.id`, so structuredClone is both
// correct (ids/ranks/suits preserved) and safe. We must first detach the fields
// that hold non-cloneable runtime objects — spectators (Map), clients (Set of
// live sockets), trusteeTimers / kickVote (Timeout handles) — all irrelevant to a
// rollout. CRITICAL: restore them in `finally`, so if structuredClone throws the
// real room isn't left corrupted (that previously nulled room.spectators forever
// and crashed the next broadcast, dropping every player).
function cloneRoom(room) {
  const detached = {
    spectators: room.spectators,
    clients: room.clients,
    trusteeTimers: room.trusteeTimers,
    kickVote: room.kickVote
  };
  room.spectators = undefined;
  room.clients = undefined;
  room.trusteeTimers = undefined;
  room.kickVote = undefined;
  let copy;
  try {
    copy = structuredClone(room);
  } finally {
    room.spectators = detached.spectators;
    room.clients = detached.clients;
    room.trusteeTimers = detached.trusteeTimers;
    room.kickVote = detached.kickVote;
  }
  copy.spectators = new Map();
  return copy;
}

// Infer which effective suits each OTHER seat has emptied: in a trick led with
// effective-suit X, a seat that played fewer than the led length in suit X must
// have run out of X (the follow rule forces playing all you hold), so it holds
// none of X going forward. This is the card counter's void memory.
function inferVoids(room, viewIndex) {
  const voids = {};
  for (const s of room.seats) if (s.index !== viewIndex) voids[s.index] = new Set();
  const scan = (plays) => {
    if (!plays.length) return;
    const ledSuit = playSuit(plays[0].cards[0], room);
    const ledLen = plays[0].cards.length;
    for (const p of plays) {
      if (p.seat === viewIndex || !voids[p.seat]) continue;
      const ledCount = p.cards.reduce((n, c) => n + (playSuit(c, room) === ledSuit ? 1 : 0), 0);
      if (ledCount < ledLen) voids[p.seat].add(ledSuit);
    }
  };
  for (const t of room.finishedTricks) scan(t.plays);
  scan(room.currentTrick);
  return voids;
}

// Constrained deal: assign every pooled card to a target (seat hand or kitty)
// respecting counts and void constraints. Most-constrained cards first; returns
// null on a dead-end so the caller can retry / fall back.
function assignConstrained(pool, targets, room, rng) {
  const esCache = new Map();
  const es = (c) => { let v = esCache.get(c.id); if (v === undefined) { v = playSuit(c, room); esCache.set(c.id, v); } return v; };
  const slots = targets.map((t) => ({ ...t, cards: [] }));
  const eligibleCount = (c) => slots.reduce((n, t) => n + (t.need > 0 && (!t.voids || !t.voids.has(es(c))) ? 1 : 0), 0);
  const cards = [...pool].sort((a, b) => eligibleCount(a) - eligibleCount(b));
  for (const c of cards) {
    const elig = slots.filter((t) => t.cards.length < t.need && (!t.voids || !t.voids.has(es(c))));
    if (!elig.length) return null;
    let tot = 0; for (const t of elig) tot += t.need - t.cards.length;
    let r = rng() * tot, chosen = elig[elig.length - 1];
    for (const t of elig) { r -= t.need - t.cards.length; if (r <= 0) { chosen = t; break; } }
    chosen.cards.push(c);
  }
  for (const t of slots) if (t.cards.length !== t.need) return null;
  return slots;
}

// ── determinization (the card counter) ─────────────────────────────────────
// Reassigns the hidden cards in `clone` to a world consistent with viewIndex's
// knowledge: its own hand (and the kitty, if it is the dealer) are left intact;
// every other seat's hand and the buried kitty are resampled from the unseen
// pool, preserving each location's card count AND respecting inferred voids.
function determinize(room, viewIndex, clone, rng) {
  const isDealer = room.dealerSeat === viewIndex;
  const view = room.seats[viewIndex];

  const known = new Set();
  for (const c of view.hand) known.add(c.id);
  for (const t of room.finishedTricks) for (const p of t.plays) for (const c of p.cards) known.add(c.id);
  for (const p of room.currentTrick) for (const c of p.cards) known.add(c.id);
  if (isDealer) for (const c of room.hiddenKitty) known.add(c.id);

  const pool = createDeck(room.deckCopies).filter((c) => !known.has(c.id));
  const voids = inferVoids(room, viewIndex);

  const targets = [];
  for (const s of room.seats) {
    if (s.index === viewIndex) continue;
    targets.push({ index: s.index, need: room.seats[s.index].hand.length, voids: voids[s.index] });
  }
  if (!isDealer) targets.push({ index: -1, need: room.hiddenKitty.length, voids: null });

  let assigned = null;
  for (let attempt = 0; attempt < 8 && !assigned; attempt += 1) assigned = assignConstrained(pool, targets, room, rng);
  if (!assigned) { // voids made a clean deal infeasible — fall back to unconstrained
    const sh = shuffle(pool, rng);
    let i = 0;
    assigned = targets.map((t) => { const cards = sh.slice(i, i + t.need); i += t.need; return { ...t, cards }; });
  }
  for (const t of assigned) {
    if (t.index === -1) clone.hiddenKitty = t.cards;
    else clone.seats[t.index].hand = t.cards;
  }
  return clone;
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

// Signed outcome from the view team's perspective. Primary term = net level
// steps (what winning actually means); fine term = attacker-point margin so the
// search can still rank moves when the level-step outcome ties.
function outcome(clone, viewOnDealer) {
  const res = clone.lastResult?.result;
  const atk = clone.scores?.attackers ?? 0;
  let steps = 0;
  if (res && res.steps > 0) {
    const dealerWon = res.side === "dealer";
    steps = dealerWon === viewOnDealer ? res.steps : -res.steps;
  }
  const pointMargin = viewOnDealer ? -atk : atk;
  return steps * 1000 + pointMargin;
}

// Which team is viewIndex on, from its OWN knowledge (it knows its hand, the
// public dealer, and — in find-friend — whether it holds the called friend card).
function viewIsDealerTeam(room, viewIndex) {
  if (viewIndex === room.dealerSeat) return true;
  if (room.mode === "fixedTeam6" || room.mode === "classic4") {
    return viewIndex % 2 === room.dealerSeat % 2;
  }
  if (room.friendSeat !== null) return viewIndex === room.friendSeat;
  const call = room.friendCall;
  if (call && room.seats[viewIndex].hand.some((c) => c.rank === call.rank && c.suit === call.suit)) return true;
  return false;
}

// Legal candidates, optionally capped to a manageable set for search. When
// capping we always keep the heuristic's own pick (so search never does worse
// than the heuristic by overlooking it) plus the leading spread of boss groups.
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
// Returns the chosen play as an array of card objects (from room's real hand),
// or null if it's not viewIndex's turn / not the playing phase.
export function pimcChoosePlay(room, viewIndex, opts = {}) {
  if (room.phase !== PLAYING || room.turnSeat !== viewIndex) return null;
  const timeBudgetMs = opts.timeBudgetMs ?? 400;
  const maxDeterminizations = opts.determinizations ?? 80;
  const rolloutLevel = opts.rolloutLevel ?? "hard";
  const rng = opts.rng ?? Math.random;

  const seat = room.seats[viewIndex];
  const leaderCards = room.currentTrick[0]?.cards ?? null;
  const candidates = selectCandidates(room, seat, leaderCards, opts);
  if (candidates.length <= 1) return candidates[0] ?? chooseAiPlay(room, seat, leaderCards);

  const viewOnDealer = viewIsDealerTeam(room, viewIndex);
  const totals = new Array(candidates.length).fill(0);
  const counts = new Array(candidates.length).fill(0);

  const start = Date.now();
  let d = 0;
  while (d < maxDeterminizations && Date.now() - start < timeBudgetMs) {
    d += 1;
    const base = cloneRoom(room);
    determinize(room, viewIndex, base, rng);
    makeAllAuto(base, rolloutLevel, rng);

    for (let ci = 0; ci < candidates.length; ci += 1) {
      const world = cloneRoom(base);
      world.trickPauseUntil = 0;
      try {
        playCards(world, world.seats[viewIndex].playerId, candidates[ci].map((c) => c.id));
        if (rolloutToEnd(world)) {
          totals[ci] += outcome(world, viewOnDealer);
          counts[ci] += 1;
        }
      } catch (_) { /* discard a broken rollout; others still count */ }
    }
  }

  let best = 0;
  let bestAvg = counts[0] ? totals[0] / counts[0] : -Infinity;
  for (let i = 1; i < candidates.length; i += 1) {
    const avg = counts[i] ? totals[i] / counts[i] : -Infinity;
    if (avg > bestAvg) { best = i; bestAvg = avg; }
  }
  return candidates[best];
}

// Diagnostics: same search but returns the per-candidate averages (for tuning /
// inspection), without committing to a move.
export function pimcEvaluate(room, viewIndex, opts = {}) {
  const seat = room.seats[viewIndex];
  const leaderCards = room.currentTrick[0]?.cards ?? null;
  const candidates = legalCandidatePlays(room, seat, leaderCards);
  const rng = opts.rng ?? Math.random;
  const viewOnDealer = viewIsDealerTeam(room, viewIndex);
  const D = opts.determinizations ?? 80;
  const totals = new Array(candidates.length).fill(0);
  const counts = new Array(candidates.length).fill(0);
  for (let d = 0; d < D; d += 1) {
    const base = cloneRoom(room);
    determinize(room, viewIndex, base, rng);
    makeAllAuto(base, opts.rolloutLevel ?? "hard", rng);
    for (let ci = 0; ci < candidates.length; ci += 1) {
      const world = cloneRoom(base);
      world.trickPauseUntil = 0;
      try {
        playCards(world, world.seats[viewIndex].playerId, candidates[ci].map((c) => c.id));
        if (rolloutToEnd(world)) { totals[ci] += outcome(world, viewOnDealer); counts[ci] += 1; }
      } catch (_) { /* skip */ }
    }
  }
  return candidates.map((c, i) => ({
    cards: c.map((x) => x.label),
    avg: counts[i] ? totals[i] / counts[i] : null,
    n: counts[i]
  })).sort((a, b) => (b.avg ?? -Infinity) - (a.avg ?? -Infinity));
}
