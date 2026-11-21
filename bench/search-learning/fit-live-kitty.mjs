import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { parseArgs } from 'node:util';
import { cardScore, rankNumber } from '../../src/cards.js';
import { chooseAiBury, playSuit, sortHand } from '../../src/game.js';
import { counts } from '../../src/ai/learning/observation.js';
import { determinizePublicWorld } from '../../src/ai/hidden-world.js';
import { mulberry32 } from '../lib/pimc-deal.mjs';
import { replayLiveSix } from './replay-live-six.mjs';

const BOTTOM_SIZE = 6;
const FEATURE_NAMES = ['trump', 'pointsPerTen', 'rankScaled', 'sideAce', 'hasPair', 'sideSuitLengthPerEight'];
const RIDGE = .025;
const TILT = .75;

const sum = values => values.reduce((total, value) => total + value, 0);
const mean = values => sum(values) / values.length;
const dot = (a, b) => sum(a.map((value, i) => value * b[i]));

function kittyFeatures(pool, room) {
  const suitCounts = {};
  const faceCopies = {};
  const suits = pool.map(card => playSuit(card, room));
  for (const [i, card] of pool.entries()) {
    suitCounts[suits[i]] = (suitCounts[suits[i]] ?? 0) + 1;
    const face = `${card.suit}:${card.rank}`;
    faceCopies[face] = (faceCopies[face] ?? 0) + 1;
  }
  return pool.map((card, i) => {
    const trump = suits[i] === 'trump';
    const rank = card.suit === 'joker' ? 14 : rankNumber(card.rank);
    return [Number(trump), cardScore(card) / 10, (rank - 2) / 12,
      Number(card.rank === 'A' && !trump), Number(faceCopies[`${card.suit}:${card.rank}`] > 1),
      trump ? 0 : suitCounts[suits[i]] / 8];
  });
}

function example(pool, kitty, room) {
  const chosen = new Set(kitty.map(card => card.id));
  const selected = pool.map(card => Number(chosen.has(card.id)));
  if (sum(selected) !== BOTTOM_SIZE) throw new Error('Kitty must be a six-card subset of dealer pool');
  return { features: kittyFeatures(pool, room), selected };
}

// A subset of six has weight equal to the product of the six card weights.
// The polynomial coefficient of x^6 in product(1 + weight_i * x) normalizes
// over all possible subsets, including when multiple copies have one face.
function subsetDistribution(scores, includeMarginals = false) {
  const shift = Math.max(...scores);
  const weights = scores.map(score => Math.exp(score - shift));
  let polynomial = new Float64Array(BOTTOM_SIZE + 1);
  polynomial[0] = 1;
  const prefix = [];
  for (const weight of weights) {
    if (includeMarginals) prefix.push(polynomial.slice());
    for (let k = BOTTOM_SIZE; k > 0; k--) polynomial[k] += weight * polynomial[k - 1];
  }
  const partition = polynomial[BOTTOM_SIZE];
  const logPartition = Math.log(partition) + BOTTOM_SIZE * shift;
  if (!includeMarginals) return { logPartition };
  const inclusion = Array(scores.length);
  polynomial = new Float64Array(BOTTOM_SIZE + 1);
  polynomial[0] = 1;
  for (let i = scores.length - 1; i >= 0; i--) {
    let otherSubsets = 0;
    for (let k = 0; k < BOTTOM_SIZE; k++) otherSubsets += prefix[i][k] * polynomial[BOTTOM_SIZE - 1 - k];
    inclusion[i] = weights[i] * otherSubsets / partition;
    for (let k = BOTTOM_SIZE - 1; k > 0; k--) polynomial[k] += weights[i] * polynomial[k - 1];
  }
  return { logPartition, inclusion };
}

function fit(examples) {
  const objective = coefficients => {
    const scale = 1 / (BOTTOM_SIZE * examples.length);
    let loss = RIDGE * dot(coefficients, coefficients) / 2;
    const gradient = coefficients.map(value => RIDGE * value);
    for (const { features, selected } of examples) {
      const scores = features.map(row => dot(row, coefficients));
      const { logPartition, inclusion } = subsetDistribution(scores, true);
      loss += (logPartition - dot(selected, scores)) * scale;
      for (const [i, row] of features.entries()) {
        for (const [j, value] of row.entries()) gradient[j] += (inclusion[i] - selected[i]) * value * scale;
      }
    }
    return { loss, gradient };
  };
  let coefficients = Array(FEATURE_NAMES.length).fill(0);
  let current = objective(coefficients);
  for (let i = 0; i < 180 && dot(current.gradient, current.gradient) > 1e-12; i++) {
    let step = 2;
    while (step >= 1e-5) {
      const trial = coefficients.map((value, index) => value - step * current.gradient[index]);
      const result = objective(trial);
      if (result.loss < current.loss) {
        coefficients = trial;
        current = result;
        break;
      }
      step /= 2;
    }
    if (step < 1e-5) break;
  }
  if (!coefficients.every(Number.isFinite)) throw new Error('Kitty fit did not converge');
  return coefficients;
}

function summarizePrediction(pool, actual, room, coefficients) {
  const { selected, features } = example(pool, actual, room);
  const scores = features.map(row => dot(row, coefficients));
  const top = pool.map((card, i) => ({ card, score: scores[i] })).sort((a, b) => b.score - a.score)
    .slice(0, BOTTOM_SIZE).map(row => row.card);
  const hand = [...pool];
  sortHand(hand, room);
  const heuristic = chooseAiBury(room, { hand, aiLevel: 'hard' });
  const target = counts(actual);
  const overlap = cards => sum(counts(cards).map((count, i) => Math.min(count, target[i])));
  return {
    modelOverlappingFaces: overlap(top),
    hardOverlappingFaces: overlap(heuristic),
    uniformOverlappingCards: BOTTOM_SIZE ** 2 / pool.length,
    modelNll: (subsetDistribution(scores).logPartition - dot(selected, scores)) / BOTTOM_SIZE,
    uniformNll: subsetDistribution(scores.map(() => 0)).logPartition / BOTTOM_SIZE
  };
}

function hiddenPrediction(room, viewer, coefficients, worlds, seed) {
  const dealerPlayed = [...room.finishedTricks.map(trick => trick.plays), room.currentTrick]
    .flatMap(plays => plays.filter(play => play.seat === room.dealerSeat).flatMap(play => play.cards));
  const rng = mulberry32(seed);
  const simulations = [];
  for (let i = 0; i < worlds; i++) {
    const hypothesis = { ...room, seats: room.seats.map(seat => ({ ...seat })) };
    if (!determinizePublicWorld(room, viewer, hypothesis, rng)) continue;
    const pool = [...hypothesis.seats[room.dealerSeat].hand, ...dealerPlayed, ...hypothesis.hiddenKitty];
    const kitty = hypothesis.hiddenKitty;
    const { features, selected } = example(pool, kitty, room);
    const scores = features.map(row => dot(row, coefficients));
    simulations.push({
      logWeight: TILT * (dot(selected, scores) - subsetDistribution(scores).logPartition),
      points: sum(kitty.map(cardScore)),
      trumps: kitty.filter(card => playSuit(card, room) === 'trump').length,
      faces: counts(kitty)
    });
  }
  if (simulations.length < worlds / 2) throw new Error('Too few feasible public card allocations');
  const shift = Math.max(...simulations.map(sample => sample.logWeight));
  const weights = simulations.map(sample => Math.exp(sample.logWeight - shift));
  const total = sum(weights);
  const actual = room.hiddenKitty;
  const actualPoints = sum(actual.map(cardScore));
  const actualTrumps = actual.filter(card => playSuit(card, room) === 'trump').length;
  const actualFaces = counts(actual);
  const error = weights => {
    const denom = sum(weights);
    const expect = project => sum(simulations.map((sample, i) => project(sample) * weights[i])) / denom;
    return {
      pointsMae: Math.abs(expect(sample => sample.points) - actualPoints),
      trumpsMae: Math.abs(expect(sample => sample.trumps) - actualTrumps),
      faceMse: mean(actualFaces.map((actualCount, face) => (expect(sample => sample.faces[face]) - actualCount) ** 2))
    };
  };
  return {
    uniform: error(simulations.map(() => 1)),
    calibrated: error(weights),
    effectiveWorlds: total ** 2 / sum(weights.map(weight => weight ** 2)),
    worlds: simulations.length
  };
}

function readRounds(directory) {
  const files = fs.readdirSync(directory).filter(file => /^[a-f0-9-]+\.json\.gz$/.test(file))
    .map(file => {
      const fullPath = path.join(directory, file);
      return { fullPath, time: fs.statSync(fullPath).mtimeMs };
    }).sort((a, b) => a.time - b.time || a.fullPath.localeCompare(b.fullPath));
  const hashes = new Set();
  return files.flatMap(({ fullPath, time }) => {
    const bytes = gunzipSync(fs.readFileSync(fullPath), { maxOutputLength: 4 * 1024 * 1024 });
    const record = JSON.parse(bytes);
    if (record.seatCount !== 6) return [];
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (hashes.has(hash)) throw new Error('Duplicate live recording');
    hashes.add(hash);
    return [{ record, time }];
  });
}

function run(directory, out, holdoutSize, worlds) {
  const rounds = readRounds(directory);
  if (!Number.isInteger(holdoutSize) || holdoutSize < 4 || rounds.length - holdoutSize < 10 ||
      !Number.isInteger(worlds) || worlds < 32) throw new Error('Need at least 10 training and 4 holdout rounds, and at least 32 worlds');
  const trainEnd = rounds.length - holdoutSize;
  const training = rounds.slice(0, trainEnd).map(({ record }) => {
    const { room, dealerPool, kitty } = replayLiveSix(record);
    return example(dealerPool, kitty, room);
  });
  const coefficients = fit(training);
  const measurements = rounds.slice(trainEnd).map(({ record }, index) => {
    const positions = new Map();
    const { room, dealerPool, kitty } = replayLiveSix(record, (room, viewer, sample, turn) => {
      const handSize = room.seats[viewer].hand.length;
      if (viewer === room.dealerSeat || handSize < 2 || handSize > 12 || sample.source !== 'human') return;
      const band = handSize <= 4 ? 0 : handSize <= 8 ? 1 : 2;
      const key = `${viewer}/${band}`;
      if (!positions.has(key)) positions.set(key, { room: structuredClone(room), viewer, turn });
    });
    const hidden = [...positions.values()].map(({ room, viewer, turn }) =>
      hiddenPrediction(room, viewer, coefficients, worlds, 983125711 + index * 7919 + turn));
    if (!hidden.length) throw new Error('A held-out deal has no eligible non-dealer endgame action');
    return { supervised: summarizePrediction(dealerPool, kitty, room, coefficients), hidden };
  });
  const averageFields = (rows, field) => Object.fromEntries(Object.keys(field(rows[0])).map(key => [
    key, mean(rows.map(row => field(row)[key]))
  ]));
  const supervised = averageFields(measurements, row => row.supervised);
  const hidden = {};
  for (const key of ['uniform', 'calibrated']) {
    hidden[key] = averageFields(measurements.map(row => averageFields(row.hidden, pos => pos[key])), row => row);
  }
  const allPositions = measurements.flatMap(row => row.hidden);
  const files = {
    'kitty-prior.json': {
      schema: 'shengji-kitty-prior-v1', seatCount: 6, bottomSize: BOTTOM_SIZE,
      featureNames: FEATURE_NAMES, coefficients, likelihoodPower: TILT,
      metadata: { trainingRounds: training.length, throughUtc: new Date(rounds[trainEnd - 1].time).toISOString(), ridge: RIDGE }
    },
    'evaluation.json': {
      schema: 'shengji-live-kitty-evaluation-v1', seatCount: 6,
      replayedRounds: rounds.length, replayedMoves: sum(rounds.map(row => row.record.samples.length)),
      humanActions: sum(rounds.map(row => row.record.humanActions)),
      split: { order: 'chronological', train: training.length, holdout: measurements.length,
        holdoutFromUtc: new Date(rounds[trainEnd].time).toISOString() },
      supervisedKnownDealerHand: supervised,
      hiddenNonDealer: { positions: allPositions.length, drawsPerPosition: worlds,
        meanEffectiveWorlds: mean(allPositions.map(row => row.effectiveWorlds)), ...hidden },
      limits: [
        'The v1 log encodes the current public bid and revealed kitty, with no full auction transcript.',
        'Hidden prediction scores the same feasible sampled allocations before and after a learned likelihood tilt.',
        'Report errors average by deal. The holdout is from the same collection period and does not measure playing strength.'
      ]
    }
  };
  fs.mkdirSync(out);
  for (const [name, value] of Object.entries(files)) {
    fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  }
  console.log(JSON.stringify(files['evaluation.json'], null, 2));
}

const { values } = parseArgs({ options: {
  rounds: { type: 'string' }, out: { type: 'string' }, holdout: { type: 'string', default: '12' },
  worlds: { type: 'string', default: '256' }
} });
if (!values.rounds || !values.out) throw new Error('Usage: node fit-live-kitty.mjs --rounds DIR --out NEW_DIR');
run(values.rounds, values.out, Number(values.holdout), Number(values.worlds));
