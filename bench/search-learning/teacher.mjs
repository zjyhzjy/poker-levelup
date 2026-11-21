import { pimcPairedOutcomes } from '../../src/ai/pimc.js';
import { mulberry32 } from '../lib/pimc-deal.mjs';

export function differenceStats(values) {
  const mean = values.reduce((sum, x) => sum + x, 0) / values.length;
  const standardError = values.length > 1
    ? Math.sqrt(values.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (values.length - 1) / values.length) : 0;
  return { mean, standardError, approximate95Interval: [mean - 1.96 * standardError, mean + 1.96 * standardError] };
}

export function teacherLabel(room, viewer, actions, worlds, seed, rolloutLevel = 'hard') {
  const samples = pimcPairedOutcomes(room, viewer, actions, { determinizations: worlds, rolloutLevel, rng: mulberry32(seed) });
  if (samples.length < Math.ceil(worlds / 2)) return null;
  const stats = actions.map((_, index) => differenceStats(samples.map(row => (row[index] - row[0]) / 1000)));
  return { advantages: stats.map(stat => stat.mean), errors: stats.map(stat => stat.standardError), worlds: samples.length };
}
