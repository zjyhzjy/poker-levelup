import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { chooseAiPlay, playCards, validatePlay } from '../../src/game.js';
import { informationSet } from '../../src/ai/learning/observation.js';
import { pimcChoosePlay } from '../../src/ai/pimc.js';
import { FULL_PLAY_HAND_LIMIT, SEARCH_HAND_LIMIT, searchPolicyForHand, searchPolicyInput,
  searchStudentChoice, validateSearchPolicy } from '../../src/ai/search-policy.js';
import { mulberry32, prepareRoom, terminalReward, withSeed } from '../learning/environment.mjs';
import { differenceStats, teacherLabel } from './teacher.mjs';

const HAND_BAND_LIMITS = [3, 5, SEARCH_HAND_LIMIT, 10, 12, 17, 22, FULL_PLAY_HAND_LIMIT];

function rulePlay(room, viewer, seed, turn, useReference) {
  const view = informationSet(room, viewer);
  const seat = view.seats[viewer];
  if (!useReference) seat.aiRngState = (seed + turn * 7919 + viewer * 40503) | 0;
  return chooseAiPlay(view, seat, view.currentTrick[0]?.cards || null);
}

function playDeal(task, config, policy, collect = false) {
  const { seed, seatCount, focal } = task;
  return withSeed(seed ^ 0x5f3759df, rng => {
    const room = prepareRoom(seed, seatCount);
    const positions = [];
    const counts = [];
    const times = [];
    let overrides = 0;
    let alternatives = 0;
    let teacherFallbacks = 0;
    let openingTurns = 0, openingOverrides = 0, masterFallbacks = 0;
    for (let turn = 0; room.phase !== 'roundOver'; turn++) {
      if (turn >= 1000 || room.phase !== 'playing') throw new Error(`Game stalled at ${seatCount}/${seed}/${turn}`);
      room.trickPauseUntil = 0;
      const viewer = room.turnSeat;
      const seat = room.seats[viewer];
      const handSize = seat.hand.length;
      const inScope = handSize <= config.handLimit;
      const ranker = policy.model && viewer === focal && searchPolicyForHand(policy.model, seatCount, handSize);
      const usePolicy = viewer === focal && inScope && (ranker || policy.id === 'teacher');
      const samplePosition = collect && inScope && handSize >= config.minHand;
      const turnSeed = seed ^ Math.imul(turn + 1, 0x9e3779b9);
      const start = performance.now();
      const input = usePolicy || samplePosition ? searchPolicyInput(room, viewer) : null;
      if (samplePosition && input.actions.length > 1) {
        const band = HAND_BAND_LIMITS.findIndex(max => handSize <= max);
        counts[band] = (counts[band] ?? 0) + 1;
        if (rng() < 1 / counts[band]) {
          positions[band] = { room: structuredClone(room), input, viewer, turn, hand: handSize, lead: !room.currentTrick.length };
        }
      }
      let cards;
      if (usePolicy) {
        let index = 0;
        if (input.actions.length > 1) {
          alternatives++;
          if (policy.id === 'teacher') {
            const label = teacherLabel(room, viewer, input.actions, config.worlds, turnSeed, config.rolloutLevel);
            if (label) index = label.advantages.indexOf(Math.max(...label.advantages));
            else teacherFallbacks++;
          } else {
            index = searchStudentChoice(room, viewer, input, ranker, mulberry32(turnSeed));
          }
        }
        cards = input.actions[index];
        if (index !== 0) overrides++;
        if (ranker && ranker === policy.model.models[seatCount].opening) {
          openingTurns++;
          if (index !== 0) openingOverrides++;
        }
        times.push(performance.now() - start);
      } else if (viewer === focal && policy.fallback === 'master') {
        seat.aiLevel = 'master';
        cards = pimcChoosePlay(room, viewer, { determinizations: 64, maxCandidates: 8, rolloutLevel: 'master',
          timeBudgetMs: config.masterMs, rng: mulberry32(turnSeed) });
        seat.aiLevel = 'hard';
        masterFallbacks++;
        times.push(performance.now() - start);
      } else {
        cards = viewer === focal && inScope && input ? input.actions[0] : rulePlay(room, viewer, seed, turn, viewer === focal && inScope);
      }
      if (!validatePlay(room, seat, cards, room.currentTrick[0]?.cards || null).ok) {
        throw new Error(`Illegal action at ${seatCount}/${seed}/${turn}`);
      }
      playCards(room, seat.playerId, cards.map(card => card.id));
    }
    if (!collect) return { net: terminalReward(room, focal) * 3, times, overrides, alternatives, teacherFallbacks,
      openingTurns, openingOverrides, masterFallbacks };

    const labels = [];
    let skipped = 0;
    for (const position of positions.filter(Boolean)) {
      const { room: snapshot, viewer, input, turn, hand, lead } = position;
      const label = teacherLabel(snapshot, viewer, input.actions, config.worlds,
        seed ^ Math.imul(turn + 1, 0x9e3779b9), config.rolloutLevel);
      if (label) labels.push({ turn, hand, lead, features: input.features, ...label });
      else skipped++;
    }
    return { labels, skipped, overrides, alternatives };
  });
}

function runWorker({ tasks, config, policies }) {
  for (const task of tasks) {
    const result = config.kind === 'collect'
      ? playDeal(task, config, policies[0], true)
      : Object.fromEntries(policies.map(policy => [policy.id, playDeal(task, config, policy)]));
    parentPort.postMessage({ ...task, result });
  }
}

function summarizeGames(rows, policies, seatCounts) {
  const modes = {};
  for (const seatCount of seatCounts) {
    const deals = rows.filter(row => row.seatCount === seatCount);
    modes[seatCount] = Object.fromEntries(policies.filter(policy => policy.id !== 'rules').map(({ id }) => {
      const times = deals.flatMap(row => row.result[id].times).sort((a, b) => a - b);
      const alternatives = deals.reduce((sum, row) => sum + row.result[id].alternatives, 0);
      const overrides = deals.reduce((sum, row) => sum + row.result[id].overrides, 0);
      return [id, {
        independentDeals: deals.length,
        vsRules: differenceStats(deals.map(row => row.result[id].net - row.result.rules.net)),
        vsTeacher: deals[0].result.teacher && id !== 'teacher'
          ? differenceStats(deals.map(row => row.result[id].net - row.result.teacher.net)) : null,
        vsPrevious: deals[0].result.previous && id !== 'previous'
          ? differenceStats(deals.map(row => row.result[id].net - row.result.previous.net)) : null,
        alternatives,
        overrides,
        openingTurns: deals.reduce((sum, row) => sum + row.result[id].openingTurns, 0),
        openingOverrides: deals.reduce((sum, row) => sum + row.result[id].openingOverrides, 0),
        masterFallbacks: deals.reduce((sum, row) => sum + row.result[id].masterFallbacks, 0),
        teacherFallbacks: deals.reduce((sum, row) => sum + row.result[id].teacherFallbacks, 0),
        timing: { decisions: times.length, meanMs: times.reduce((sum, ms) => sum + ms, 0) / Math.max(1, times.length),
          p95Ms: times[Math.max(0, Math.ceil(times.length * .95) - 1)] ?? null }
      }];
    }));
  }
  return modes;
}

async function main() {
  const { values } = parseArgs({ options: {
    kind: { type: 'string' }, out: { type: 'string' }, deals: { type: 'string' }, seed: { type: 'string' },
    worlds: { type: 'string', default: '24' }, workers: { type: 'string', default: '4' },
    student: { type: 'string' }, models: { type: 'string' }, teacher: { type: 'boolean' },
    'seat-count': { type: 'string' }, 'hand-limit': { type: 'string' }, 'min-hand': { type: 'string' },
    'rollout-level': { type: 'string', default: 'hard' }, 'master-ms': { type: 'string', default: '1300' }
  } });
  const config = { kind: values.kind, deals: Number(values.deals), seed: Number(values.seed),
    worlds: Number(values.worlds), workers: Number(values.workers),
    seatCounts: values['seat-count'] ? [Number(values['seat-count'])] : [5, 6],
    handLimit: Number(values['hand-limit'] ?? SEARCH_HAND_LIMIT), minHand: Number(values['min-hand'] ?? 2),
    rolloutLevel: values['rollout-level'], masterMs: Number(values['master-ms']) };
  if (!['collect', 'evaluate'].includes(config.kind) || !values.out ||
      !Number.isInteger(config.deals) || config.deals < 2 || config.deals > 1000 ||
      !Number.isSafeInteger(config.seed) || config.seed < 0 || config.seed + 10000000 + (config.deals - 1) * 7919 > 0xffffffff ||
      !Number.isInteger(config.worlds) || config.worlds < 2 || config.worlds > 128 ||
      !Number.isInteger(config.workers) || config.workers < 1 || config.workers > 12 ||
      config.seatCounts.some(n => n !== 5 && n !== 6) ||
      !Number.isInteger(config.handLimit) || config.handLimit < SEARCH_HAND_LIMIT || config.handLimit > FULL_PLAY_HAND_LIMIT ||
      !Number.isInteger(config.minHand) || config.minHand < 2 || config.minHand > config.handLimit ||
      !['hard', 'master'].includes(config.rolloutLevel) || !Number.isFinite(config.masterMs) || config.masterMs <= 0) {
    throw new Error('Invalid experiment settings. Use --kind collect|evaluate, --out, --deals 2..1000 and a uint32 --seed');
  }
  const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
  const rules = { id: 'rules' };
  const candidates = values.models ? read(values.models) : [];
  if (!Array.isArray(candidates) || candidates.some(candidate => typeof candidate?.id !== 'string' || !candidate.id || !candidate.model)) {
    throw new Error('Expected an array of named student models');
  }
  const policies = config.kind === 'collect'
    ? [values.student ? { id: 'student', model: validateSearchPolicy(read(values.student)) } : rules]
    : [rules, ...(values.teacher ? [{ id: 'teacher' }] : []), ...candidates];
  if (config.kind === 'evaluate' && policies.length < 2) throw new Error('Provide --models or --teacher');
  if (new Set(policies.map(policy => policy.id)).size !== policies.length) throw new Error('Duplicate policy ID');
  for (const policy of policies) {
    if (policy.id === 'rules' || policy.id === 'teacher') continue;
    validateSearchPolicy(policy.model);
    if (config.seatCounts.some(n => !policy.model.seatCounts.includes(n))) throw new Error('Model is missing an experiment seat count');
    if (policy.fallback !== undefined && policy.fallback !== 'master') throw new Error('Unsupported model fallback');
  }
  const tasks = config.seatCounts.flatMap(seatCount => Array.from({ length: config.deals }, (_, index) => ({
    seatCount, seed: config.seed + (seatCount - 5) * 10000000 + index * 7919, focal: index % seatCount
  })));
  for (const { model } of policies) {
    const used = new Set([...(model?.metadata?.trainingSeeds || []), ...(model?.metadata?.selectionSeeds || [])]);
    if (tasks.some(task => used.has(task.seed))) throw new Error('Deal seeds overlap training or selection');
  }
  try { os.setPriority(process.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
  const out = path.resolve(values.out);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'config.json'), JSON.stringify({ ...config, policies: policies.map(policy => policy.id) }, null, 2), { flag: 'wx' });
  const rows = [];
  const fd = fs.openSync(path.join(out, 'deals.jsonl'), 'wx');
  const workers = [];
  let positions = 0;
  const startedAt = Date.now();
  try {
    await Promise.all(Array.from({ length: config.workers }, (_, index) => new Promise((resolve, reject) => {
      const group = tasks.filter((_, taskIndex) => taskIndex % config.workers === index);
      const worker = new Worker(new URL(import.meta.url), { workerData: { tasks: group, config, policies } });
      workers.push(worker);
      worker.on('message', row => {
        fs.writeSync(fd, JSON.stringify(row) + '\n');
        rows.push(row);
        positions += row.result.labels?.length || 0;
        if (rows.length % 32 === 0) console.log(JSON.stringify({ deals: rows.length, totalDeals: tasks.length, positions }));
      });
      worker.once('error', reject);
      worker.once('exit', code => code === 0 ? resolve() : reject(new Error(`Experiment worker exited ${code}`)));
    })));
  } finally {
    await Promise.allSettled(workers.map(worker => worker.terminate()));
    fs.closeSync(fd);
  }
  if (rows.length !== tasks.length) throw new Error('Incomplete experiment');
  rows.sort((a, b) => a.seatCount - b.seatCount || a.seed - b.seed);
  const report = { complete: true, config, dealSeeds: tasks.map(task => task.seed), elapsedMs: Date.now() - startedAt };
  if (config.kind === 'collect') {
    report.modes = Object.fromEntries(config.seatCounts.map(seatCount => {
      const modeRows = rows.filter(row => row.seatCount === seatCount);
      const labels = modeRows.flatMap(row => row.result.labels);
      return [seatCount, { deals: modeRows.length, positions: labels.length, actions: labels.reduce((sum, row) => sum + row.features.length, 0),
        pairedWorlds: labels.reduce((sum, row) => sum + row.worlds, 0), skipped: modeRows.reduce((sum, row) => sum + row.result.skipped, 0),
        studentOverrides: modeRows.reduce((sum, row) => sum + row.result.overrides, 0) }];
    }));
  } else {
    report.games = rows.length * policies.length;
    report.modes = summarizeGames(rows, policies, config.seatCounts);
  }
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ complete: true, deals: rows.length, games: report.games, positions, elapsedMs: report.elapsedMs }));
}

if (isMainThread) await main();
else runWorker(workerData);
