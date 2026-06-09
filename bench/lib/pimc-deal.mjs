// Shared deal driver for PIMC evaluation (used by the sequential and the
// parallel worker-thread harnesses). Plays one 5-player deal; optionally lets
// the dealer's team (dealer + friend once revealed) use the PIMC search while
// everyone else uses the heuristic.
import {
  addAiPlayer, confirmDealer, createRoom, decideAiBid, makeBid, passBid,
  revealKittyCard, runAiStep, startAuction, startRound, playCards, constants,
  upgradeResult
} from "../../src/game.js";
import { pimcChoosePlay } from "../../src/ai/pimc.js";

const { PLAYING, ROUND_OVER } = constants.PHASES;

export function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}

export function runAuction(room) {
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

// pimcSide ∈ "none" | "dealer". Returns null if the deal didn't reach/finish play.
export function playDeal(seed, pimcSide, pimcOpts) {
  const room = createRoom("EVAL", { seatCount: 5 });
  for (let i = 0; i < 5; i++) addAiPlayer(room, i, "hard");
  for (const s of room.seats) { s.aiRngState = (seed * 2654435761 + s.index * 40503) | 0; s.aiBias = 0; }
  startRound(room, mulberry32(seed));
  runAuction(room);

  let g = 0;
  while (room.phase !== PLAYING && room.phase !== ROUND_OVER && g++ < 60) { room.trickPauseUntil = 0; if (!runAiStep(room)) break; }
  if (room.phase !== PLAYING) return null;

  let nonce = (seed * 0x9e3779b9) | 0;
  const decisionRng = () => { nonce = (nonce + 0x6D2B79F5) | 0; return mulberry32(nonce)(); };

  let steps = 0;
  while (room.phase !== ROUND_OVER && steps++ < 6000) {
    room.trickPauseUntil = 0;
    if (room.phase === PLAYING) {
      const seat = room.turnSeat;
      const onDealerTeam = seat === room.dealerSeat || room.friendSeat === seat;
      if (pimcSide === "dealer" && onDealerTeam) {
        const cards = pimcChoosePlay(room, seat, { ...pimcOpts, rng: () => decisionRng() });
        playCards(room, room.seats[seat].playerId, cards.map((c) => c.id));
        continue;
      }
    }
    if (!runAiStep(room)) break;
  }
  if (room.phase !== ROUND_OVER) return null;
  const atk = room.scores.attackers;
  const res = room.lastResult?.result ?? upgradeResult(atk);
  const dealerNet = res.side === "dealer" ? res.steps : res.side === "attackers" ? -res.steps : 0;
  return { atk, dealerNet, dealerWin: atk < 120 };
}

// Run a contiguous block of deals (base + test per seed) and return partial sums.
export function evalBlock(startIndex, count, pimcOpts) {
  const acc = { n: 0, baseNet: 0, testNet: 0, baseWins: 0, testWins: 0, improved: 0, worse: 0 };
  for (let s = startIndex; s < startIndex + count; s++) {
    const seed = (s * 7919) >>> 0;
    const base = playDeal(seed, "none", pimcOpts);
    const test = playDeal(seed, "dealer", pimcOpts);
    if (!base || !test) continue;
    acc.n++;
    acc.baseNet += base.dealerNet; acc.testNet += test.dealerNet;
    acc.baseWins += base.dealerWin ? 1 : 0; acc.testWins += test.dealerWin ? 1 : 0;
    if (test.dealerNet > base.dealerNet) acc.improved++;
    else if (test.dealerNet < base.dealerNet) acc.worse++;
  }
  return acc;
}
