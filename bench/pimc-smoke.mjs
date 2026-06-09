// Smoke test: drive one 4-player deal to the PLAYING phase, then exercise the
// PIMC search at a real decision point and confirm it returns a legal move and
// that a full heuristic rollout reaches roundOver. Also sanity-checks the
// determinization card counts.
import {
  addAiPlayer, confirmDealer, createRoom, decideAiBid, makeBid, passBid,
  revealKittyCard, runAiStep, startAuction, startRound, playCards, constants,
  legalCandidatePlays
} from "../src/game.js";
import { pimcChoosePlay, pimcEvaluate } from "../src/ai/pimc.js";
import { createDeck } from "../src/cards.js";

const { PLAYING, ROUND_OVER } = constants.PHASES;

function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}

function runAuction(room) {
  let ch = true, g = 0;
  while (ch && g++ < 50) {
    ch = false;
    for (const s of room.seats) {
      if (!["dealing", "auctionReady", "auction"].includes(room.phase)) break;
      if (room.bidResponses[s.index] || (room.currentBid && room.currentBid.seat === s.index)) continue;
      const d = decideAiBid(room, s);
      if (d && (!room.currentBid || d.strength > room.currentBid.strength)) { makeBid(room, s.playerId, d.cardIds); ch = true; }
      else if (room.currentBid) { passBid(room, s.playerId); ch = true; }
    }
  }
  if (room.currentBid && ["dealing", "auctionReady", "auction"].includes(room.phase)) { try { confirmDealer(room); } catch {} }
  if (!room.currentBid) { if (room.phase === "auctionReady") startAuction(room); let k = 0; while (room.phase === "auction" && k++ < 10) revealKittyCard(room); }
}

const seed = Number(process.argv[2] || 12345);
const seatCount = Number(process.argv[3] || 4);
const room = createRoom("SMOKE", { seatCount });
for (let i = 0; i < seatCount; i++) addAiPlayer(room, i, "hard");
for (const s of room.seats) { s.aiRngState = (seed * 2654435761 + s.index * 40503) | 0; s.aiBias = 0; }
startRound(room, mulberry32(seed));
runAuction(room);

// advance (heuristic) through forced-suit / burying / friend until PLAYING
let g = 0;
while (room.phase !== PLAYING && room.phase !== ROUND_OVER && g++ < 50) { room.trickPauseUntil = 0; if (!runAiStep(room)) break; }
console.log("phase after setup:", room.phase, "| dealer:", room.dealerSeat, "| trump:", room.trumpSuit, "| level:", room.levelRank);
if (room.phase !== PLAYING) { console.log("did not reach PLAYING — abort smoke"); process.exit(1); }

// ── determinization count sanity check ──
function knownCount(room, viewIndex) {
  const isDealer = room.dealerSeat === viewIndex;
  const known = new Set();
  for (const c of room.seats[viewIndex].hand) known.add(c.id);
  for (const t of room.finishedTricks) for (const p of t.plays) for (const c of p.cards) known.add(c.id);
  for (const p of room.currentTrick) for (const c of p.cards) known.add(c.id);
  if (isDealer) for (const c of room.hiddenKitty) known.add(c.id);
  const pool = createDeck(room.deckCopies).length - known.size;
  let need = 0;
  for (const s of room.seats) if (s.index !== viewIndex) need += s.hand.length;
  if (!isDealer) need += room.hiddenKitty.length;
  return { pool, need, ok: pool === need };
}
const view = room.turnSeat;
console.log("determinization check (seat", view, "):", knownCount(room, view));

// ── run PIMC at the current decision ──
const t0 = Date.now();
const evald = pimcEvaluate(room, view, { determinizations: 30, rng: mulberry32(seed ^ 0x9e3779b9) });
const dt = Date.now() - t0;
console.log(`\npimcEvaluate (30 determinizations) took ${dt}ms — per-candidate avg outcomes:`);
for (const e of evald) console.log(`   ${String(e.avg?.toFixed(1)).padStart(9)}  (n=${e.n})  ${e.cards.join(" ")}`);

const legal = legalCandidatePlays(room, room.seats[view], room.currentTrick[0]?.cards ?? null);
const pick = pimcChoosePlay(room, view, { determinizations: 30, rng: mulberry32(seed) });
console.log("\nlegal candidate count:", legal.length);
console.log("PIMC picked:", pick.map((c) => c.label).join(" "));

// ── confirm a full game completes when one seat uses PIMC ──
let steps = 0;
const pimcSeats = new Set([0, 2].filter((i) => i < seatCount));
while (room.phase !== ROUND_OVER && steps++ < 5000) {
  room.trickPauseUntil = 0;
  if (room.phase === PLAYING && pimcSeats.has(room.turnSeat)) {
    const seat = room.seats[room.turnSeat];
    const cards = pimcChoosePlay(room, room.turnSeat, { determinizations: 15, rng: mulberry32(steps * 2654435761) });
    playCards(room, seat.playerId, cards.map((c) => c.id));
  } else if (!runAiStep(room)) break;
}
console.log("\nfinal phase:", room.phase, "| steps:", steps);
console.log("result:", JSON.stringify(room.lastResult?.result), "| attackers:", room.scores.attackers);
console.log(room.phase === ROUND_OVER ? "✅ SMOKE PASSED" : "❌ did not finish");
