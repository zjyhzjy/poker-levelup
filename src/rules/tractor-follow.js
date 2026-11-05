// Match each requested tractor to a separate run. Prefer the longest available
// segment for each demand, processing longer demands first.
export function planTractorRuns(groups, counts, consecutive) {
  const demands = [...counts].sort((a, b) => b - a);
  if (!demands.length) return [];
  const runsByLength = new Map();
  function extend(indices, mask) {
    const length = indices.length;
    if (length >= 2) {
      const runs = runsByLength.get(length) || [];
      runs.push({ mask, groups: indices.map((i) => groups[i]) });
      runsByLength.set(length, runs);
    }
    if (length === demands[0]) return;
    const last = indices.at(-1);
    for (let i = last + 1; i < groups.length; i++) {
      if (consecutive(groups[last][0], groups[i][0])) {
        extend([...indices, i], mask | (1 << i));
      }
    }
  }
  for (let i = 0; i < groups.length; i++) extend([i], 1 << i);

  const memo = new Map();
  function search(index, used) {
    if (index === demands.length) return [];
    const key = `${index}:${used}`;
    if (memo.has(key)) return memo.get(key);
    let best;
    for (let length = demands[index]; length >= 2 && !best; length--) {
      for (const run of runsByLength.get(length) || []) {
        if (run.mask & used) continue;
        const candidate = [run.groups, ...search(index + 1, used | run.mask)];
        if (!best || comparePlans(candidate, best) > 0) best = candidate;
      }
    }
    if (!best) best = [[], ...search(index + 1, used)];
    memo.set(key, best);
    return best;
  }
  return search(0, 0);
}

export function comparePlans(a, b) {
  for (let i = 0; i < a.length; i++) {
    const difference = a[i].length - b[i].length;
    if (difference) return difference;
  }
  return 0;
}

export function throwGroupDemands(leaderGroups, pairGroups, tripleGroups) {
  const leaderTriples = leaderGroups.filter((group) => group.length === 3).length;
  const leaderPairs = leaderGroups.filter((group) => group.length === 2).length;
  const triples = Math.min(leaderTriples, tripleGroups.length);
  return { triples, pairs: Math.min(leaderPairs + leaderTriples - triples, pairGroups.length) };
}

export function splitThrowGroups(groups, consecutive, weight) {
  const components = [];
  for (const unit of [1, 2, 3]) {
    let pool = groups.filter((group) => group.length === unit);
    while (unit > 1 && pool.length >= 2) {
      const [run] = planTractorRuns(pool, [pool.length], consecutive);
      if (!run.length) break;
      components.push({ kind: "tractor", unit, count: run.length, cards: run.flat() });
      const used = new Set(run);
      pool = pool.filter((group) => !used.has(group));
    }
    for (const cards of pool) {
      components.push({ kind: unit === 1 ? "single" : "group", unit, count: 1, cards });
    }
  }
  return components.sort((a, b) => weight(b.cards[0]) - weight(a.cards[0]));
}
