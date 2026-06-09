// Self-play deal driver for weight tuning. Plays one 5-player deal where the
// dealer's team (dealer + friend once revealed) uses one weight set and everyone
// else uses another — both pure heuristic "hard" (fast, no search). Bidding is
// weight-independent (decideAiBid uses profile, not AI_WEIGHTS), so for a given
// seed the dealer/friend assignment is identical regardless of weights → clean
// common-random-numbers comparison.
import { addAiPlayer, createRoom, runAiStep, startRound, constants, upgradeResult } from "../../src/game.js";
import { runAuction, mulberry32 } from "./pimc-deal.mjs";

const { PLAYING, ROUND_OVER } = constants.PHASES;

// Returns the dealer team's net level-steps (+win / −loss), or null if the deal
// didn't reach/finish play. Weights are applied per-decision so the friend seat
// switches to dealerW the moment it's revealed.
export function tunedDealNet(seed, dealerW, otherW) {
  try {
    const room = createRoom("TUNE", { seatCount: 5 });
    for (let i = 0; i < 5; i++) addAiPlayer(room, i, "hard");
    for (const s of room.seats) { s.aiRngState = (seed * 2654435761 + s.index * 40503) | 0; s.aiBias = 0; }
    startRound(room, mulberry32(seed));
    runAuction(room);

    let g = 0;
    while (room.phase !== PLAYING && room.phase !== ROUND_OVER && g++ < 60) { room.trickPauseUntil = 0; if (!runAiStep(room)) break; }
    if (room.phase !== PLAYING) return null;

    let steps = 0;
    while (room.phase !== ROUND_OVER && steps++ < 6000) {
      room.trickPauseUntil = 0;
      if (room.phase === PLAYING) {
        const seat = room.seats[room.turnSeat];
        const onDealer = seat.index === room.dealerSeat || room.friendSeat === seat.index;
        seat.aiWeights = onDealer ? dealerW : otherW;
      }
      if (!runAiStep(room)) break;
    }
    if (room.phase !== ROUND_OVER) return null;
    const atk = room.scores.attackers;
    const res = room.lastResult?.result ?? upgradeResult(atk);
    return res.side === "dealer" ? res.steps : res.side === "attackers" ? -res.steps : 0;
  } catch (_) {
    return null; // skip a deal that hit a rare engine error rather than crash the run
  }
}

// Fitness of weight set W vs a fixed reference `base`, averaged over `seeds`
// (common random numbers). For each seed we play W as the dealer team and W as
// the attackers; the reference's contribution cancels, leaving W's net edge:
//   fitness = mean[ net(dealer=W, others=base) − net(dealer=base, others=W) ].
// 0 ⇒ no better than the reference; positive ⇒ W plays stronger.
export function fitness(W, base, seeds) {
  let sum = 0, n = 0;
  for (const seed of seeds) {
    const a = tunedDealNet(seed, W, base); // W on the dealer team
    const b = tunedDealNet(seed, base, W); // W on the attacking team
    if (a === null || b === null) continue;
    sum += a - b;
    n++;
  }
  return n ? sum / n : 0;
}
