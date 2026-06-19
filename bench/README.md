# AI evaluation harness

Tools for measuring whether an AI change actually makes the Shengji AI stronger.
All harnesses play **offline 5-player self-play** with deterministic per-seat RNG
(seeded, personality bias zeroed) so a given seed reproduces an identical game and
any metric delta is attributable to the code/weights change, not luck.

## The metric

`outcome` / **net level-step edge**: the dealer team's signed level advance per deal
(+steps if the dealer team wins, −steps if the attackers win). Averaged over many
deals it measures relative strength. Head-to-head harnesses report it on **symmetric
mirrored deals** (each config plays both sides of the same seed) so the structural
dealer advantage and seed luck cancel, leaving an unbiased A−B edge ± std err.

## Files

| File | Purpose |
|------|---------|
| `ai-eval.mjs` | Mixed-layout balance / engine-stability smoke. Reports `crashes` (now an honest "deal failed to complete" gate — see below), voluntary-bid rate, outcome split, dealer net level-steps by difficulty. |
| `ab-eval.mjs` | **Generic A/B**: pit any two AI configs (weight files / `factory` / `tuned`) head-to-head on mirrored deals. Net edge ± std err + win-rate Δ. Fast. |
| `validate-weights.mjs` | Hardwired tuned-vs-factory A/B on fresh seeds (the canonical ship gate for a retune). |
| `pimc-eval.mjs` | PIMC-search-vs-heuristic A/B (slow). |
| `tune-weights.mjs` | Self-play weight optimizer. |
| `lib/tune-deal.mjs`, `lib/pimc-deal.mjs` | Shared offline deal drivers (auction, `forcedSuit` resolution, play-out). |

## Recommended verification of "did my AI change get stronger?"

Run these from the repo root. Sample sizes below give a tight CI (std err ≈ 0.01,
so a real edge ≳ +0.03 level steps shows up cleanly).

```bash
# 0. Engine-stability gate — crashes MUST be ~0 for every difficulty, or the
#    measurement below is unreliable. ~1–2 min total.
node bench/ai-eval.mjs 3000 easy,easy,easy,easy,easy
node bench/ai-eval.mjs 3000 medium,medium,medium,medium,medium
node bench/ai-eval.mjs 3000 hard,hard,hard,hard,hard

# 1. Head-to-head: new config (A) vs the current ship (B). ~40s at 20000 seeds.
#    A weight file is {"weights": {...}}; `factory` = src/game.js defaults,
#    `tuned` = bench/tuned-weights.json.
node bench/ab-eval.mjs ./candidate.json tuned 20000
#    Sanity that the harness is unbiased (must print edge +0.0000):
node bench/ab-eval.mjs factory factory 4000

# 2. If the change is a retune of tuned-weights.json, the canonical gate:
node bench/validate-weights.mjs 20000
```

**Ship rule of thumb:** require the edge to read `SOLID >0` (mean − 2·stderr > 0,
i.e. ≳ 2σ). "not significant" means grow `seeds` or the change is noise.

## Caveat — these are PROXY metrics

This is fast, unbiased *self-play against the existing heuristic*. It does **not**
prove the AI is better for humans: it can reward exploiting quirks of the opponent
model, and it ignores UX, tempo, and obvious-blunder feel. A positive number is a
green light to look closer, not a guarantee. **Always pair a positive result with a
human eyeball of a few real hands** (e.g. watch a live game or replay) before shipping.

## The `forcedSuit` stability fix (why crashes used to be inflated)

When nobody bids voluntarily, the engine runs `forceDealer()` and lands in the
`forcedSuit` (翻底定庄) phase, gated by a wall-clock "spin" countdown that the live
server clears with timers (`scheduleAi` → `chooseForcedTrump` → bid responses). The
offline drivers have no wall clock, so `runAiStep` returned `false` and the deal
stalled there — previously **miscounted as a crash** (easy ~100%, medium ~34%,
hard ~16%). `resolveForcedSuit()` in `lib/pimc-deal.mjs` now replicates the server's
resolution synchronously (drop the spin, dealer chooses its forced trump, other seats
over-bid-or-pass → `confirmDealer`), driven from every offline pre-play loop. Crash
rates now sit at ~0, so the `crashes` field is once again an honest engine-stability
gate.
