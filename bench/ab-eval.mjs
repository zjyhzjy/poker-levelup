// Generic head-to-head A/B harness for the Shengji AI.
//
// Pits TWO AI configurations against each other on SYMMETRIC mirrored deals
// (common random numbers): for every seed we play A-as-dealer-team / B-as-attackers
// AND B-as-dealer-team / A-as-attackers, and report the NET difference. The mirror
// cancels the structural dealer advantage and any seed-to-seed luck, so a non-zero
// edge is attributable to the configs, not the deal. This is the same metric and
// estimator validate-weights.mjs uses (net level-step edge ± std err, win-rate Δ),
// just parameterized so you can A/B arbitrary configs instead of only tuned-vs-factory.
//
// USAGE
//   node bench/ab-eval.mjs [configA] [configB] [seeds] [workers]
//   # or with env: AB_A=... AB_B=... AB_SEEDS=... AB_WORKERS=... node bench/ab-eval.mjs
//
// A "config" is resolved to an AI weight vector (the per-decision knob the engine
// reads via seat.aiWeights). Accepted forms:
//   factory                  → shipped AI_WEIGHTS defaults (src/game.js)
//   tuned                    → bench/tuned-weights.json
//   <path/to/weights.json>   → a {"weights": {...}} file (or a bare {...} of knobs)
//
// EXAMPLES
//   node bench/ab-eval.mjs tuned factory 20000        # is the tuned set actually better?
//   node bench/ab-eval.mjs ./candidate.json tuned     # new candidate vs current ship
//   node bench/ab-eval.mjs factory factory 4000       # sanity: identical configs → edge ≈ 0
//
// READING THE RESULT
//   edge (A − B) > 0 ............ config A plays stronger than config B
//   "SOLID >0" (mean − 2·stderr) . the edge clears ~2σ; treat as a real improvement
//   "not significant" .......... within noise; grow `seeds` for a tighter CI
//
// NOTE: this is a PROXY metric (5-player heuristic self-play, mirrored). It is fast
// and unbiased but does NOT prove a config is better for humans — always pair a
// positive result with a human eyeball of a few real hands before shipping.
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { AI_WEIGHTS } from "../src/game.js";
import { tunedDealNet } from "./lib/tune-deal.mjs";

const self = fileURLToPath(import.meta.url);
const here = path.dirname(self);
const FACTORY = { ...AI_WEIGHTS };

// Resolve a config token to a full weight vector (factory defaults overlaid with the
// config's known knobs, so partial weight files are fine).
function resolveConfig(token) {
  if (!token || token === "factory" || token === "default" || token === "base") {
    return { label: "factory", weights: { ...FACTORY } };
  }
  const file = token === "tuned" ? path.join(here, "tuned-weights.json") : token;
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const knobs = raw && typeof raw === "object" && raw.weights ? raw.weights : raw;
  return { label: path.basename(file), weights: { ...FACTORY, ...knobs } };
}

// Fresh seeds, salt distinct from the tuner (0xABCD/0x5151) and validate-weights (0x7E57)
// so an A/B run never silently reuses training seeds.
const seedAt = (i) => ((i * 1000003 + 0xAB1E) >>> 0);

if (!isMainThread) {
  const { start, count, wA, wB } = workerData;
  let sumDiff = 0, sumSq = 0, n = 0, winA = 0, winB = 0;
  for (let i = start; i < start + count; i++) {
    const seed = seedAt(i);
    const a = tunedDealNet(seed, wA, wB); // dealer team = A, attackers = B
    const b = tunedDealNet(seed, wB, wA); // dealer team = B, attackers = A
    if (a === null || b === null) continue; // skip deals that didn't finish
    const d = a - b;                        // A's net advantage on this mirrored pair
    sumDiff += d; sumSq += d * d; n++;
    if (a > 0) winA++; // A won its deal as dealer
    if (b > 0) winB++; // B won its deal as dealer
  }
  parentPort.postMessage({ sumDiff, sumSq, n, winA, winB });
} else {
  const A = resolveConfig(process.argv[2] || process.env.AB_A || "tuned");
  const B = resolveConfig(process.argv[3] || process.env.AB_B || "factory");
  const N = Number(process.argv[4] || process.env.AB_SEEDS || 6000);
  const WORKERS = Number(process.argv[5] || process.env.AB_WORKERS || Math.max(1, Math.min(os.cpus().length - 1, 9)));

  console.log(`\n=== A/B: ${A.label} (A) vs ${B.label} (B) | ${N} mirrored seeds | ${WORKERS} workers ===`);
  const per = Math.ceil(N / WORKERS);
  const t0 = Date.now();
  const jobs = [];
  for (let w = 0; w < WORKERS; w++) {
    const start = w * per;
    const count = Math.min(per, N - start);
    if (count <= 0) break;
    jobs.push(new Promise((res, rej) => {
      const worker = new Worker(self, { workerData: { start, count, wA: A.weights, wB: B.weights } });
      worker.on("message", res); worker.on("error", rej);
    }));
  }
  const parts = await Promise.all(jobs);
  const acc = parts.reduce((s, p) => ({
    sumDiff: s.sumDiff + p.sumDiff, sumSq: s.sumSq + p.sumSq, n: s.n + p.n,
    winA: s.winA + p.winA, winB: s.winB + p.winB,
  }), { sumDiff: 0, sumSq: 0, n: 0, winA: 0, winB: 0 });

  if (!acc.n) { console.log("no deals completed — check the configs / driver"); process.exit(1); }
  const mean = acc.sumDiff / acc.n;
  const variance = acc.sumSq / acc.n - mean * mean;
  const stderr = Math.sqrt(Math.max(0, variance) / acc.n);
  const dt = ((Date.now() - t0) / 1000).toFixed(0);
  const verdict = mean - 2 * stderr > 0 ? "A SOLID >0" : mean + 2 * stderr < 0 ? "B better" : "not significant";
  console.log(`completed ${acc.n} deals in ${dt}s`);
  console.log(`net-level-step edge (A − B): ${mean >= 0 ? "+" : ""}${mean.toFixed(4)}  ± ${stderr.toFixed(4)} (std err)`);
  console.log(`   → ${stderr > 0 ? (mean / stderr).toFixed(1) : "∞"}σ from zero  (${verdict})`);
  console.log(`dealer win-rate:  A-as-dealer ${(100 * acc.winA / acc.n).toFixed(1)}%   B-as-dealer ${(100 * acc.winB / acc.n).toFixed(1)}%   Δ ${(100 * (acc.winA - acc.winB) / acc.n).toFixed(1)}pt`);
}
