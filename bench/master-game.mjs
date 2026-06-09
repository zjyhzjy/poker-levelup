// Integration check: a full 5-player game with some seats at the new "master"
// level, driven exactly like server.js (master seats → pimcChoosePlay, others →
// runAiStep). Confirms addAiPlayer accepts "master" and the round completes.
import { addAiPlayer, createRoom, runAiStep, playCards, startRound, constants, aiProfile } from "../src/game.js";
import { pimcChoosePlay } from "../src/ai/pimc.js";
import { runAuction, mulberry32 } from "./lib/pimc-deal.mjs";

const { PLAYING, ROUND_OVER } = constants.PHASES;
const seed = Number(process.argv[2] || 2026);
const room = createRoom("MASTER", { seatCount: 5 });
const levels = ["master", "hard", "master", "hard", "hard"];
levels.forEach((lv, i) => addAiPlayer(room, i, lv));
console.log("seat levels:", room.seats.map((s) => s.aiLevel).join(", "));
console.log("master profile resolves:", JSON.stringify(aiProfile(room.seats[0])).slice(0, 60), "...");

for (const s of room.seats) { s.aiRngState = (seed * 2654435761 + s.index * 40503) | 0; }
startRound(room, mulberry32(seed));
runAuction(room);

const OPTS = { determinizations: 16, maxCandidates: 6, timeBudgetMs: 700, rolloutLevel: "hard" };
let steps = 0, masterMoves = 0;
const t0 = Date.now();
while (room.phase !== ROUND_OVER && steps++ < 6000) {
  room.trickPauseUntil = 0;
  if (room.phase === PLAYING) {
    const seat = room.seats[room.turnSeat];
    if (seat.aiLevel === "master") {
      const cards = pimcChoosePlay(room, room.turnSeat, OPTS);
      playCards(room, seat.playerId, cards.map((c) => c.id));
      masterMoves++;
      continue;
    }
  }
  if (!runAiStep(room)) break;
}
console.log(`\nfinal phase: ${room.phase} | steps: ${steps} | master PIMC moves: ${masterMoves} | ${((Date.now()-t0)/1000).toFixed(1)}s`);
console.log("result:", JSON.stringify(room.lastResult?.result), "| attackers:", room.scores.attackers);
console.log(room.phase === ROUND_OVER ? "✅ MASTER INTEGRATION OK" : "❌ did not finish");
