"""Distill full-round action rankers from synthetic and reconstructed live positions."""
import argparse
import copy
import json
from pathlib import Path

from train import FEATURE_SIZE, SCHEMA, fit_ranker, np, read_labels, teacher_targets


def read_synthetic(directories):
    examples = {5: [], 6: []}
    used = set()
    for directory in directories:
        groups, seeds, _ = read_labels(directory, include_hand=True)
        if used & seeds:
            raise ValueError('Synthetic collections overlap')
        used.update(seeds)
        for mode in examples:
            examples[mode].extend(groups[mode])
    return examples, used


def read_live(directory, split):
    report = json.loads((directory / 'result.json').read_text(encoding='utf8'))
    if not report['complete'] or report['seatCount'] != 6:
        raise ValueError('Incomplete live action collection')
    positions, hashes = [], set()
    with (directory / f'{split}.jsonl').open(encoding='utf8') as file:
        for line in file:
            row = json.loads(line)
            if row['split'] != split or row['hash'] in hashes:
                raise ValueError('Invalid live split')
            hashes.add(row['hash'])
            for action in row['decisions']:
                x = np.asarray(action['features'], dtype=np.float32)
                if (x.ndim != 2 or x.shape[1] != FEATURE_SIZE or not 2 <= len(x) <= 8
                        or not np.isfinite(x).all() or not -1 <= action['human'] < len(x)
                        or not 2 <= action['hand'] <= 26):
                    raise ValueError('Invalid live decision')
                teacher = None
                if 'worlds' in action:
                    y = np.asarray(action['advantages'], dtype=np.float32)
                    se = np.asarray(action['errors'], dtype=np.float32)
                    if (y.shape != (len(x),) or se.shape != y.shape or y[0] != 0
                            or not np.isfinite(y).all() or not np.isfinite(se).all() or np.any(se < 0)
                            or action['worlds'] * 2 < report['requestedWorlds']):
                        raise ValueError('Invalid live teacher label')
                    teacher = (x, y, se)
                positions.append((x, action['human'], action['hand'], teacher))
    split_report = report['splits'][split]
    if len(hashes) != split_report['rounds'] or len(positions) != split_report['positions']:
        raise ValueError('Incomplete live decision file')
    return positions, hashes


def for_stage(data, limit, opening):
    return [row for row in data if (row[-1] > limit) == opening]


def live_for_stage(data, limit, opening):
    return [row for row in data if (row[2] > limit) == opening]


def train_stage(synthetic, validation, live, live_validation, seed, imitation_weight):
    outcomes = teacher_targets([row[:3] for row in synthetic])
    heldout = teacher_targets([row[:3] for row in validation])
    from_live_search = [row[3] for row in live if row[3] is not None]
    outcomes.extend((x, y, 1.6 * weight) for x, y, weight in teacher_targets(from_live_search))
    heldout.extend(teacher_targets([row[3] for row in live_validation if row[3] is not None]))
    human_count = 0
    for x, chosen, _, _ in live:
        if chosen >= 0 and imitation_weight:
            target = np.full(len(x), .10 / len(x), dtype=np.float32)
            target[chosen] += .90
            outcomes.append((x, target, imitation_weight))
            human_count += 1
    if len(outcomes) < 20 or len(heldout) < 10:
        raise ValueError('Insufficient labels across this stage')
    features = np.concatenate([row[0] for row in outcomes])
    mean, scale = features.mean(axis=0), np.maximum(features.std(axis=0), .05)
    learned = fit_ranker(outcomes, heldout, mean, scale, seed)
    return learned, {
        'syntheticTeacher': len(synthetic), 'liveTeacher': len(from_live_search),
        'humanDecisions': human_count, 'validationTeacher': len(heldout), 'epoch': learned['epoch']
    }


def write_json(file, value):
    with file.open('x', encoding='utf8') as stream:
        json.dump(value, stream, allow_nan=False, separators=(',', ':'))


def model_score(ranker, features):
    if ranker['kind'] == 'linear':
        return features @ np.asarray(ranker['coefficients'])
    return np.tanh(features @ np.asarray(ranker['weights']).T + ranker['bias']) @ np.asarray(ranker['output'])


def measure(model, live):
    result = {}
    policy = model['models']['6']
    limit = policy.get('handLimit', model['handLimit'])
    for stage, opening in [('openingAndMiddle', True), ('endgame', False)]:
        ranker = policy.get('opening') if opening else policy
        positions = live_for_stage(live, limit, opening)
        moves = agreements = changes = 0
        regret, rule_regret = [], []
        for features, human, _, teacher in positions:
            pick = 0
            if ranker:
                scores = model_score(ranker, features)
                best = int(np.argmax(scores))
                if scores[best] - scores[0] > ranker['margin']:
                    pick = best
            changes += pick != 0
            if human >= 0:
                agreements += pick == human
                moves += 1
            if teacher is not None:
                y = teacher[1]
                regret.append(float(y.max() - y[pick]))
                rule_regret.append(float(y.max() - y[0]))
        result[stage] = {
            'positions': len(positions), 'matchesHuman': agreements, 'humanInCandidates': moves,
            'teacherPositions': len(regret), 'changesFromRules': changes,
            'meanTeacherRegret': float(np.mean(regret)), 'rulesTeacherRegret': float(np.mean(rule_regret))
        }
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', type=Path)
    parser.add_argument('--synthetic', action='append', type=Path)
    parser.add_argument('--development', action='append', type=Path)
    parser.add_argument('--live', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--measure', action='append', type=Path)
    args = parser.parse_args()
    if args.measure:
        live, hashes = read_live(args.live, 'test')
        reports = {}
        for file in args.measure:
            model = json.loads(file.read_text(encoding='utf8'))
            meta = model['metadata']
            if hashes & set(meta.get('liveTrainingRounds', []) + meta.get('liveSelectionRounds', [])):
                raise ValueError('Real test overlaps model fitting or selection')
            reports[file.stem] = measure(model, live)
        write_json(args.out, {'rounds': len(hashes), 'rankerOnly': True, 'models': reports})
        print(json.dumps(reports))
        return
    if not args.base or not args.synthetic or not args.development:
        parser.error('Provide --base, --synthetic and --development collections')
    base = json.loads(args.base.read_text(encoding='utf8'))
    if base['schema'] != SCHEMA or set(base['seatCounts']) != {5, 6}:
        raise ValueError('Expected a base search-distilled model with both modes')
    synthetic, train_seeds = read_synthetic(args.synthetic)
    validation, validation_seeds = read_synthetic(args.development)
    if train_seeds & validation_seeds:
        raise ValueError('Development overlaps synthetic training')
    live, live_train = read_live(args.live, 'train')
    live_dev, live_selection = read_live(args.live, 'validation')
    if live_train & live_selection:
        raise ValueError('Development overlaps live training')
    limits = {n: base['models'][str(n)].get('handLimit', base['handLimit']) for n in (5, 6)}
    source = {}
    for n in (5, 6):
        sim_opening = for_stage(synthetic[n], limits[n], True)
        dev_opening = for_stage(validation[n], limits[n], True)
        model, stats = train_stage(sim_opening, dev_opening, [], [], 1151700 + n, 0)
        source[f'simulation-{n}'] = (model, stats)
    for opening, name in [(True, 'opening'), (False, 'endgame')]:
        n = 6
        teacher = for_stage(synthetic[n], limits[n], opening)
        heldout = for_stage(validation[n], limits[n], opening)
        real = live_for_stage(live, limits[n], opening)
        real_dev = live_for_stage(live_dev, limits[n], opening)
        model, stats = train_stage(teacher, heldout, real, real_dev, 1151706 + int(not opening), .18)
        source[name] = (model, stats)

    def full_model(opening6, margin, endgame=False, early_search=False, direct=False):
        model = copy.deepcopy(base)
        for n, name in [(5, 'simulation-5'), (6, opening6)]:
            model['models'][str(n)]['opening'] = {**source[name][0], 'margin': margin}
        if endgame:
            incumbent = model['models']['6']
            model['models']['6'] = {**source['endgame'][0], 'margin': .025, 'handLimit': limits[6],
                                   'opening': incumbent['opening'], 'search': incumbent['search']}
        if early_search:
            search = {'worlds': 8, 'candidates': 3, 'probeWorlds': 0, 'priorWorlds': 3,
                      'confidence': .30, 'pointWeight': .50, 'rolloutLevel': 'master'}
            for n in (5, 6):
                model['models'][str(n)]['opening']['search'] = search
        if direct:
            for n in (5, 6):
                model['models'][str(n)].pop('search', None)
        trained_live = opening6 == 'opening'
        base_meta = base['metadata']
        model['metadata'] = {
            **base_meta,
            'source': 'Full play distillation from search and matched human choices',
            'trainingSeeds': sorted(set(base_meta['trainingSeeds']) | train_seeds),
            'selectionSeeds': sorted(set(base_meta['selectionSeeds']) | validation_seeds),
            'liveTrainingRounds': sorted(live_train) if trained_live else [],
            'liveSelectionRounds': sorted(live_selection) if trained_live else [],
            'openingTraining': {5: source['simulation-5'][1], 6: source[opening6][1]},
            'retrainedSixEndgame': source['endgame'][1] if endgame else None
        }
        return model

    candidates = [
        {'id': 'previous', 'model': base},
        {'id': 'simulation', 'model': full_model('simulation-6', .045)},
        {'id': 'live', 'model': full_model('opening', .045)},
        {'id': 'live-cautious', 'model': full_model('opening', .095)},
        {'id': 'live-both-stages', 'model': full_model('opening', .045, endgame=True)},
        {'id': 'live-guided', 'model': full_model('opening', .045, early_search=True)},
        {'id': 'direct', 'model': full_model('opening', .045, endgame=True, direct=True)}
    ]
    args.out.mkdir()
    write_json(args.out / 'candidates.json', candidates)
    print(json.dumps({name: stats for name, (_, stats) in source.items()}))


if __name__ == '__main__':
    main()
