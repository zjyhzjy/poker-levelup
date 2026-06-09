// Honest final validation of tuned weights vs the shipped defaults, on a LARGE
// block of FRESH seeds (a different salt than tuning used — so no overfitting to
// the training seeds). Parallel across workers.
//
//   node bench/validate-weights.mjs [seeds] [workers] [weightsFile]
//
// Reports the symmetric net-level-step edge (± std error) and the win-rate of
// tuned-as-dealer vs default-as-dealer. Deploy only if the edge is solidly > 0.
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { AI_WEIGHTS } from "../src/game.js";
import { tunedDealNet } from "./lib/tune-deal.mjs";

const self = fileURLToPath(import.meta.url);
const DEFAULT = { ...AI_WEIGHTS };
// fresh seeds, salt distinct from the tuner's (0xABCD / 0x5151)
const seedAt = (i) => ((i * 1000003 + 0x7E57) >>> 0);

if (!isMainThread) {
  const { start, count, tuned } = workerData;
  let sumDiff = 0, n = 0, winTunedDealer = 0, winDefDealer = 0, sumSq = 0;
  for (let i = start; i < start + count; i++) {
    const seed = seedAt(i);
    const a = tunedDealNet(seed, tuned, DEFAULT);   // dealer = tuned, attackers = default
    const b = tunedDealNet(seed, DEFAULT, tuned);   // dealer = default, attackers = tuned
    if (a === null || b === null) continue;
    const d = a - b;
    sumDiff += d; sumSq += d * d; n++;
    if (a > 0) winTunedDealer++;
    if (b > 0) winDefDealer++;
  }
  parentPort.postMessage({ sumDiff, sumSq, n, winTunedDealer, winDefDealer });
} else {
  const N = Number(process.argv[2] || 6000);
  const WORKERS = Number(process.argv[3] || Math.max(1, Math.min(os.cpus().length - 1, 9)));
  const file = process.argv[4] || path.join(path.dirname(self), "tuned-weights.json");
  const tuned = { ...DEFAULT, ...JSON.parse(fs.readFileSync(file, "utf8")).weights };

  console.log(`\n=== validating ${path.basename(file)} vs shipped defaults | ${N} fresh seeds | ${WORKERS} workers ===`);
  const per = Math.ceil(N / WORKERS);
  const t0 = Date.now();
  const jobs = [];
  for (let w = 0; w < WORKERS; w++) {
    const start = w * per;
    const count = Math.min(per, N - start);
    if (count <= 0) break;
    jobs.push(new Promise((res, rej) => {
      const worker = new Worker(self, { workerData: { start, count, tuned } });
      worker.on("message", res); worker.on("error", rej);
    }));
  }
  const parts = await Promise.all(jobs);
  const a = parts.reduce((s, p) => ({ sumDiff: s.sumDiff + p.sumDiff, sumSq: s.sumSq + p.sumSq, n: s.n + p.n, winTunedDealer: s.winTunedDealer + p.winTunedDealer, winDefDealer: s.winDefDealer + p.winDefDealer }), { sumDiff: 0, sumSq: 0, n: 0, winTunedDealer: 0, winDefDealer: 0 });
  const mean = a.sumDiff / a.n;
  const variance = a.sumSq / a.n - mean * mean;
  const stderr = Math.sqrt(variance / a.n);
  const dt = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`completed ${a.n} deals in ${dt}s`);
  console.log(`net-level-step edge (tuned − default): ${mean >= 0 ? "+" : ""}${mean.toFixed(4)}  ± ${stderr.toFixed(4)} (std err)`);
  console.log(`   → ${(mean / stderr).toFixed(1)}σ from zero  (${mean - 2 * stderr > 0 ? "SOLID >0" : mean + 2 * stderr < 0 ? "WORSE" : "not significant"})`);
  console.log(`dealer win-rate:  tuned-as-dealer ${(100 * a.winTunedDealer / a.n).toFixed(1)}%   default-as-dealer ${(100 * a.winDefDealer / a.n).toFixed(1)}%   Δ ${(100 * (a.winTunedDealer - a.winDefDealer) / a.n).toFixed(1)}pt`);
}
