// Reproducible AI evaluation harness.
//   node bench/ai-eval.mjs [games] [layout]
//   layout = comma list of easy|medium|hard for the 5 seats (default all medium)
//
// For a CONTROLLED before/after benchmark it seeds each seat's RNG deterministically
// and zeroes the personality bias, so identical seeds produce identical games and any
// metric change is attributable purely to the code change.
import { addAiPlayer, confirmDealer, createRoom, decideAiBid, makeBid, passBid, revealKittyCard, runAiStep, startAuction, startRound, upgradeResult } from "../src/game.js";

function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}

// Synchronous mirror of the server's auction (scheduleAiBids) for offline play.
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

function playGame(levels, seed) {
  const room = createRoom("BENCH");
  levels.forEach((lv, i) => addAiPlayer(room, i, lv));
  for (const s of room.seats) { s.aiRngState = (seed * 2654435761 + s.index * 40503) | 0; s.aiBias = 0; } // deterministic
  startRound(room, mulberry32(seed));
  runAuction(room);
  let steps = 0, ok = true;
  try { while (room.phase !== "roundOver" && steps++ < 3000) runAiStep(room); }
  catch { ok = false; }
  if (room.phase !== "roundOver") ok = false;
  return ok ? room : null;
}

const N = Number(process.argv[2] || 3000);
const layout = (process.argv[3] || "medium,medium,medium,medium,medium").split(",");

let games = 0, crash = 0, voluntary = 0;
let atkSum = 0;
const dealerSteps = {}; // by dealer difficulty -> {sum, n}
const tiers = { dealerWin: 0, push: 0, attackersWin: 0 }; // attackers <120 / 120-160 / >160
for (const lv of ["easy", "medium", "hard"]) dealerSteps[lv] = { sum: 0, n: 0 };

for (let s = 1; s <= N; s++) {
  const room = playGame(layout, (s * 7919) >>> 0);
  if (!room) { crash++; continue; }
  games++;
  const atk = room.scores.attackers;
  atkSum += atk;
  if (room.currentBid && room.currentBid.strength >= 1) voluntary++;
  const r = upgradeResult(atk);
  const signed = r.side === "dealer" ? r.steps : r.side === "attackers" ? -r.steps : 0; // dealer's net
  const dl = layout[room.dealerSeat];
  dealerSteps[dl].sum += signed; dealerSteps[dl].n++;
  if (atk < 120) tiers.dealerWin++; else if (atk <= 160) tiers.push++; else tiers.attackersWin++;
}

const pct = (x) => (100 * x / games).toFixed(1) + "%";
console.log(`\n=== ${games}/${N} games | layout ${layout.join("/")} ===`);
console.log(`crashes: ${crash}   voluntary-bid: ${pct(voluntary)}`);
console.log(`attacker score: mean ${(atkSum / games).toFixed(1)}`);
console.log(`outcome:  dealer-win ${pct(tiers.dealerWin)}   push ${pct(tiers.push)}   attackers-win ${pct(tiers.attackersWin)}`);
console.log(`dealer net level-steps (higher = stronger dealer):`);
for (const lv of ["easy", "medium", "hard"]) {
  const d = dealerSteps[lv];
  if (d.n) console.log(`   dealer=${lv.padEnd(7)} ${(d.sum / d.n >= 0 ? "+" : "")}${(d.sum / d.n).toFixed(3)}  (n=${d.n})`);
}
