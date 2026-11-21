import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { searchHandLimit, validateSearchPolicy } from '../../src/ai/search-policy.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: 'string' } } });
if (!values.out || !positionals.length || positionals.length % 2) {
  throw new Error('Usage: node select.mjs --out DIR candidates.json development-result.json [...]');
}
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const choices = { 5: [], 6: [] };
let developmentSeeds;
for (let i = 0; i < positionals.length; i += 2) {
  const file = path.resolve(positionals[i]);
  const candidates = read(file);
  const report = read(positionals[i + 1]);
  if (!report.complete || report.config.kind !== 'evaluate' || !Array.isArray(report.dealSeeds)) {
    throw new Error('Expected complete development games');
  }
  if (developmentSeeds && JSON.stringify(developmentSeeds) !== JSON.stringify(report.dealSeeds)) {
    throw new Error('Candidates must be compared on the same development deals');
  }
  developmentSeeds = report.dealSeeds;
  const iteration = path.basename(path.dirname(file));
  for (const { id, model, labelValidation } of candidates) {
    validateSearchPolicy(model);
    for (const n of [5, 6]) {
      const games = report.modes?.[n]?.[id];
      if (!Number.isFinite(games?.vsRules?.mean)) throw new Error(`Missing development games for ${id}/${n}`);
      choices[n].push({ id, iteration, model, games, labelValidation: labelValidation[n] });
    }
  }
}

const selected = {};
for (const n of [5, 6]) {
  choices[n].sort((a, b) => b.games.vsRules.mean - a.games.vsRules.mean ||
    a.labelValidation.meanTeacherRegret - b.labelValidation.meanTeacherRegret);
  selected[n] = choices[n][0];
}
const mergeSeeds = name => [...new Set(Object.values(selected).flatMap(row => row.model.metadata[name]))].sort((a, b) => a - b);
const summarize = row => ({ id: row.id, iteration: row.iteration, games: row.games, labelValidation: row.labelValidation });
const handLimits = [5, 6].map(n => searchHandLimit(selected[n].model, n));
const model = validateSearchPolicy({
  ...selected[5].model,
  handLimit: Math.max(...handLimits),
  models: Object.fromEntries([5, 6].map((n, i) => [n, { ...selected[n].model.models[n], handLimit: handLimits[i] }])),
  metadata: {
    trainingSeeds: mergeSeeds('trainingSeeds'),
    selectionSeeds: [...new Set([...mergeSeeds('selectionSeeds'), ...developmentSeeds])].sort((a, b) => a - b),
    trainingPositions: { 5: selected[5].model.metadata.trainingPositions[5], 6: selected[6].model.metadata.trainingPositions[6] },
    selected: { 5: summarize(selected[5]), 6: summarize(selected[6]) },
    criterion: 'Maximize mean paired net-level difference on development games; break ties by lower teacher regret'
  }
});
fs.mkdirSync(values.out, { recursive: false });
const save = (name, value) => fs.writeFileSync(path.join(values.out, name), JSON.stringify(value, null, 2));
save('student.json', model);
for (const n of [5, 6]) save(`student-${n}.json`, { ...model, seatCounts: [n], models: { [n]: model.models[n] } });
save('evaluation-models.json', [{ id: 'student', model }]);
save('selection.json', { selected: model.metadata.selected, candidates: { 5: choices[5].map(summarize), 6: choices[6].map(summarize) } });
console.log(JSON.stringify({ 5: summarize(selected[5]), 6: summarize(selected[6]) }));
