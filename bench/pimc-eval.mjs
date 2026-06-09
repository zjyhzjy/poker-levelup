// Parallel PIMC-vs-heuristic strength A/B across all CPU cores.
//
//   node bench/pimc-eval.mjs [games] [determinizations] [maxCandidates] [workers]
//
// Splits `games` seeds across worker threads; each plays every deal twice
// (baseline all-heuristic vs dealer-team-PIMC) and returns partial sums, which
// the main thread aggregates. See bench/lib/pimc-deal.mjs for the per-deal logic.
import os from "node:os";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { evalBlock } from "./lib/pimc-deal.mjs";

if (!isMainThread) {
  const { start, count, pimcOpts } = workerData;
  parentPort.postMessage(evalBlock(start, count, pimcOpts));
} else {
  const N = Number(process.argv[2] || 80);
  const determinizations = Number(process.argv[3] || 24);
  const maxCandidates = Number(process.argv[4] || 8);
  const workers = Number(process.argv[5] || Math.max(1, Math.min(os.cpus().length - 1, 9)));
  const pimcOpts = { determinizations, maxCandidates, timeBudgetMs: 60000, rolloutLevel: "hard" };

  const self = fileURLToPath(import.meta.url);
  const per = Math.ceil(N / workers);
  console.log(`\n=== PIMC vs heuristic | ${N} deals | det=${determinizations} maxCand=${maxCandidates} | ${workers} workers ===`);
  const t0 = Date.now();

  const jobs = [];
  for (let w = 0; w < workers; w++) {
    const start = w * per + 1;
    const count = Math.min(per, N - w * per);
    if (count <= 0) break;
    jobs.push(new Promise((resolve, reject) => {
      const worker = new Worker(self, { workerData: { start, count, pimcOpts } });
      worker.on("message", resolve);
      worker.on("error", reject);
    }));
  }

  const parts = await Promise.all(jobs);
  const a = parts.reduce((s, p) => ({
    n: s.n + p.n, baseNet: s.baseNet + p.baseNet, testNet: s.testNet + p.testNet,
    baseWins: s.baseWins + p.baseWins, testWins: s.testWins + p.testWins,
    improved: s.improved + p.improved, worse: s.worse + p.worse
  }), { n: 0, baseNet: 0, testNet: 0, baseWins: 0, testWins: 0, improved: 0, worse: 0 });

  const dt = ((Date.now() - t0) / 1000).toFixed(0);
  const n = a.n || 1;
  console.log(`\ncompleted ${a.n}/${N} deals in ${dt}s`);
  console.log(`dealer net level-steps:  heuristic ${(a.baseNet/n).toFixed(3)}   PIMC ${(a.testNet/n).toFixed(3)}   Δ ${((a.testNet-a.baseNet)/n >= 0 ? "+" : "")}${((a.testNet-a.baseNet)/n).toFixed(3)}`);
  console.log(`dealer win-rate:         heuristic ${(100*a.baseWins/n).toFixed(1)}%   PIMC ${(100*a.testWins/n).toFixed(1)}%`);
  console.log(`per-deal: PIMC better in ${a.improved}, worse in ${a.worse}, tie in ${a.n-a.improved-a.worse}`);
}
