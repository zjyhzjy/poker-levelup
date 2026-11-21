import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { FACES } from '../../src/ai/learning/observation.js';
import { searchPolicyInput } from '../../src/ai/search-policy.js';
import { mulberry32 } from '../lib/pimc-deal.mjs';
import { replayLiveSix } from './replay-live-six.mjs';
import { teacherLabel } from './teacher.mjs';

const read = file => gunzipSync(fs.readFileSync(file), { maxOutputLength: 4 * 1024 * 1024 });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const BAND_LIMITS = [6, 12, 19, 31];

function estimateRound(task, worlds) {
  const bytes = read(task.file);
  if (digest(bytes) !== task.hash) throw new Error('A selected live recording changed');
  const record = JSON.parse(bytes);
  const rng = mulberry32(91711331 + task.index * 7919);
  const decisions = [];
  const reservoirs = new Map();
  const bandCounts = new Map();
  replayLiveSix(record, (room, viewer, row, turn) => {
    if (row.source !== 'human') return;
    const hand = room.seats[viewer].hand.length;
    const input = searchPolicyInput(room, viewer);
    if (input.actions.length < 2) return;
    const human = input.features.findIndex(feature => FACES.every((_, i) => feature[i] === row.action[i]));
    const lead = room.currentTrick.length === 0;
    const decision = { turn, hand, lead, human, features: input.features };
    decisions.push(decision);
    const group = BAND_LIMITS.findIndex(limit => hand <= limit) * 2 + Number(lead);
    const seen = (bandCounts.get(group) ?? 0) + 1;
    bandCounts.set(group, seen);
    if (rng() < 1 / seen) reservoirs.set(group, { room: structuredClone(room), viewer, actions: input.actions, decision });
  });
  let skipped = 0;
  for (const { room, viewer, actions, decision } of reservoirs.values()) {
    const label = teacherLabel(room, viewer, actions, worlds, 113511711 ^ Math.imul(task.index + 1, 7919) ^
      Math.imul(decision.turn + 1, 0x9e3779b9), 'master');
    if (label) Object.assign(decision, label);
    else skipped++;
  }
  return { index: task.index, split: task.split, hash: task.hash,
    moves: record.samples.length, humanActions: record.humanActions, skipped, decisions };
}

function plan(directory, development, holdout) {
  const entries = fs.readdirSync(directory).filter(name => /^[a-f0-9-]+\.json\.gz$/.test(name)).map(name => {
    const file = path.resolve(directory, name);
    return { file, time: fs.statSync(file).mtimeMs };
  }).sort((a, b) => a.time - b.time || a.file.localeCompare(b.file));
  const six = [];
  const known = new Set();
  for (const { file } of entries) {
    const bytes = read(file);
    if (JSON.parse(bytes).seatCount !== 6) continue;
    const hash = digest(bytes);
    if (known.has(hash)) throw new Error('Duplicate live recording');
    known.add(hash);
    six.push({ file, hash });
  }
  if (six.length - development - holdout < 10) throw new Error('Need at least 10 training rounds after reserving validation and test rounds');
  return six.map(({ file, hash }, index) => ({
    file, hash, index, split: index >= six.length - holdout ? 'test'
      : index >= six.length - holdout - development ? 'validation' : 'train'
  }));
}

async function main() {
  const { values } = parseArgs({ options: {
    rounds: { type: 'string' }, out: { type: 'string' },
    development: { type: 'string', default: '4' }, holdout: { type: 'string', default: '12' },
    worlds: { type: 'string', default: '8' }, workers: { type: 'string', default: '4' }
  } });
  const development = Number(values.development), holdout = Number(values.holdout);
  const worlds = Number(values.worlds), workers = Number(values.workers);
  if (!values.rounds || !values.out || !Number.isInteger(development) || development < 2 ||
      !Number.isInteger(holdout) || holdout < 4 || !Number.isInteger(worlds) || worlds < 4 || worlds > 64 ||
      !Number.isInteger(workers) || workers < 1 || workers > 12) throw new Error('Invalid live action collection options');
  const tasks = plan(values.rounds, development, holdout);
  try { os.setPriority(process.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
  fs.mkdirSync(values.out);
  const rows = [];
  const threads = [];
  try {
    await Promise.all(Array.from({ length: workers }, (_, index) => new Promise((resolve, reject) => {
      const worker = new Worker(new URL(import.meta.url), {
        workerData: { tasks: tasks.filter((_, i) => i % workers === index), worlds }
      });
      threads.push(worker);
      worker.on('message', row => {
        rows.push(row);
        if (rows.length % 5 === 0) console.log(JSON.stringify({ completed: rows.length, total: tasks.length }));
      });
      worker.once('error', reject);
      worker.once('exit', code => code ? reject(new Error(`Live action worker exited ${code}`)) : resolve());
    })));
  } finally {
    await Promise.allSettled(threads.map(worker => worker.terminate()));
  }
  if (rows.length !== tasks.length) throw new Error('Incomplete live action collection');
  rows.sort((a, b) => a.index - b.index);
  const report = { complete: true, seatCount: 6, requestedWorlds: worlds, splits: {} };
  for (const split of ['train', 'validation', 'test']) {
    const rounds = rows.filter(row => row.split === split);
    const positions = rounds.flatMap(row => row.decisions);
    report.splits[split] = {
      rounds: rounds.length, moves: rounds.reduce((n, row) => n + row.moves, 0),
      humanActions: rounds.reduce((n, row) => n + row.humanActions, 0),
      positions: positions.length, humanInCandidates: positions.filter(pos => pos.human >= 0).length,
      teacherPositions: positions.filter(pos => pos.worlds).length,
      skipped: rounds.reduce((n, row) => n + row.skipped, 0)
    };
    fs.writeFileSync(path.join(values.out, split + '.jsonl'), rounds.map(row => JSON.stringify(row)).join('\n') + '\n', { flag: 'wx' });
  }
  fs.writeFileSync(path.join(values.out, 'result.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(report));
}

if (isMainThread) await main();
else for (const task of workerData.tasks) parentPort.postMessage(estimateRound(task, workerData.worlds));
