// Self-play weight tuner (Cross-Entropy Method) for the heuristic AI_WEIGHTS.
//
//   node bench/tune-weights.mjs [timeBudgetSec] [seedsPerEval] [population] [workers]
//
// Optimises the scoreFollow/scoreLead weight vector by self-play against the
// SHIPPED defaults (a fixed reference opponent). Each generation samples a
// population from N(μ, σ²), ranks them by fitness vs the defaults using common
// random numbers, keeps the elites, and re-fits μ/σ. The elite mean μ is
// validated on a FRESH seed block each generation; the best-validated μ is
// checkpointed to bench/tuned-weights.json so the run can be stopped anytime and
// deployed (server loads it at startup if present).
//
// Heuristic-vs-heuristic games are fast and weight-only; tuning the heuristic
// also lifts the PIMC search, which uses it as its rollout policy.
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { AI_WEIGHTS } from "../src/game.js";
import { fitness } from "./lib/tune-deal.mjs";

const KEYS = Object.keys(AI_WEIGHTS);
const DEFAULT = KEYS.map((k) => AI_WEIGHTS[k]);
const LO = DEFAULT.map(() => 0);
const HI = DEFAULT.map((d) => Math.max(d * 5, 0.05)); // generous cap; allow →0
const vecToObj = (v) => Object.fromEntries(KEYS.map((k, i) => [k, v[i]]));
const clamp = (v) => v.map((x, i) => Math.min(HI[i], Math.max(LO[i], x)));

// ── worker: evaluate a list of candidate vectors against DEFAULT on `seeds` ──
if (!isMainThread) {
  const { candidates, seeds } = workerData;
  const out = candidates.map((v) => fitness(vecToObj(v), vecToObj(DEFAULT), seeds));
  parentPort.postMessage(out);
} else {
  const TIME_BUDGET_SEC = Number(process.argv[2] || 6 * 3600); // default 6h (well under 1 day)
  const SEEDS_PER_EVAL = Number(process.argv[3] || 400);
  const POP = Number(process.argv[4] || 36);
  const WORKERS = Number(process.argv[5] || Math.max(1, Math.min(os.cpus().length - 1, 9)));
  const ELITE = Math.max(4, Math.round(POP * 0.25));
  const self = fileURLToPath(import.meta.url);
  const OUT = path.join(path.dirname(self), "tuned-weights.json");
  const LOG = path.join(path.dirname(self), "tune-progress.log");

  function rng(seed) { return () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const R = rng(0x12345 ^ Date.now());
  function gauss() { let u = 0, v = 0; while (u === 0) u = R(); while (v === 0) v = R(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  const seedBlock = (salt, m) => Array.from({ length: m }, (_, i) => ((salt * 2654435761 + i * 7919) >>> 0));

  // evaluate `cands` (vectors) across workers on `seeds`
  async function evalPop(cands, seeds) {
    const per = Math.ceil(cands.length / WORKERS);
    const jobs = [];
    for (let w = 0; w < WORKERS; w++) {
      const chunk = cands.slice(w * per, (w + 1) * per);
      if (!chunk.length) break;
      jobs.push(new Promise((res, rej) => {
        const worker = new Worker(self, { workerData: { candidates: chunk, seeds } });
        worker.on("message", res); worker.on("error", rej);
      }));
    }
    return (await Promise.all(jobs)).flat();
  }

  // warm-start μ from a prior checkpoint if present (resume a converged run)
  let mu = DEFAULT.slice();
  try {
    if (fs.existsSync(OUT)) {
      const prev = JSON.parse(fs.readFileSync(OUT, "utf8"));
      if (prev?.weights) { mu = clamp(KEYS.map((k) => (typeof prev.weights[k] === "number" ? prev.weights[k] : AI_WEIGHTS[k]))); console.log(`(warm-start μ from ${path.basename(OUT)}, prior valFit ${prev.valFitness})`); }
    }
  } catch { /* ignore, start from defaults */ }
  let sigma = DEFAULT.map((d) => Math.max(0.3 * d, 0.03));
  let bestVal = -Infinity, bestMu = mu.slice(), bestGen = 0;

  const log = (s) => { console.log(s); fs.appendFileSync(LOG, s + "\n"); };
  log(`\n=== CEM weight tuning | budget ${TIME_BUDGET_SEC}s | seeds/eval ${SEEDS_PER_EVAL} | pop ${POP} elite ${ELITE} | ${WORKERS} workers ===`);
  log(`keys(${KEYS.length}): ${KEYS.join(",")}`);
  const t0 = Date.now();

  let gen = 0;
  while ((Date.now() - t0) / 1000 < TIME_BUDGET_SEC) {
    gen++;
    // sample population (always include current μ as a survivor)
    const cands = [mu.slice()];
    for (let i = 1; i < POP; i++) cands.push(clamp(mu.map((m, j) => m + sigma[j] * gauss())));
    const seeds = seedBlock(0xABCD ^ (gen * 2246822519), SEEDS_PER_EVAL);

    const fits = await evalPop(cands, seeds);
    const order = fits.map((f, i) => [f, i]).sort((a, b) => b[0] - a[0]);
    const elites = order.slice(0, ELITE).map(([, i]) => cands[i]);

    // refit μ/σ from elites with a small noise floor to avoid premature collapse
    mu = KEYS.map((_, j) => elites.reduce((s, e) => s + e[j], 0) / ELITE);
    sigma = KEYS.map((_, j) => {
      const m = mu[j];
      const varj = elites.reduce((s, e) => s + (e[j] - m) ** 2, 0) / ELITE;
      return Math.max(Math.sqrt(varj), 0.05 * Math.max(DEFAULT[j], 0.02));
    });
    mu = clamp(mu);

    // validate μ on a FRESH seed block (held-out) → unbiased edge over defaults
    const valSeeds = seedBlock(0x5151 ^ (gen * 40503), Math.min(SEEDS_PER_EVAL * 2, 1200));
    const [valFit] = await evalPop([mu], valSeeds);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    log(`gen ${String(gen).padStart(3)} | bestPopFit ${order[0][0].toFixed(4)} | μ valFit ${valFit.toFixed(4)} | best ${bestVal.toFixed(4)}@g${bestGen} | ${elapsed}s`);

    if (valFit > bestVal) {
      bestVal = valFit; bestMu = mu.slice(); bestGen = gen;
      fs.writeFileSync(OUT, JSON.stringify({
        generatedAt: new Date().toISOString(), generation: gen, valFitness: valFit,
        seedsPerEval: SEEDS_PER_EVAL, valSeeds: valSeeds.length, weights: vecToObj(bestMu)
      }, null, 2));
      log(`   ↑ new best valFit ${valFit.toFixed(4)} → saved ${path.basename(OUT)}`);
    }
  }
  log(`\nDONE after ${gen} gens. best valFit ${bestVal.toFixed(4)} @ gen ${bestGen}. weights → ${OUT}`);
  log(`(valFit = mean net-level-step edge over shipped defaults; >0 means stronger.)`);
}
