"""Fit separate supervised action rankers to paired PIMC estimates."""
import argparse
import json
import os
from pathlib import Path

for name in ('OPENBLAS_NUM_THREADS', 'OMP_NUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ.setdefault(name, '1')

import numpy as np

SCHEMA = 'shengji-search-distillation-v1'
FEATURE_SIZE = 100
HAND_LIMIT = 8
MAX_HAND_LIMIT = 12
FULL_PLAY_HAND_LIMIT = 31
MARGINS = (0.015, 0.06, 0.15)
RANK_TEMPERATURE = .12


def read_labels(directory, include_hand=False):
    report = json.loads((directory / 'result.json').read_text(encoding='utf8'))
    if not report['complete'] or report['config']['kind'] != 'collect':
        raise ValueError(f'Incomplete label collection: {directory}')
    cases = [json.loads(line) for line in (directory / 'deals.jsonl').read_text(encoding='utf8').splitlines()]
    cases.sort(key=lambda case: (case['seatCount'], case['seed']))
    seeds = {case['seed'] for case in cases}
    if len(cases) != len(seeds) or seeds != set(report['dealSeeds']):
        raise ValueError(f'Missing or repeated deals: {directory}')
    groups = {5: [], 6: []}
    limits = {5: HAND_LIMIT, 6: HAND_LIMIT}
    hand_limit = FULL_PLAY_HAND_LIMIT if include_hand else MAX_HAND_LIMIT
    for case in cases:
        for label in case['result']['labels']:
            x = np.asarray(label['features'], dtype=np.float32)
            y = np.asarray(label['advantages'], dtype=np.float32)
            se = np.asarray(label['errors'], dtype=np.float32)
            if (not 2 <= len(x) <= 8 or x.shape != (len(y), FEATURE_SIZE) or se.shape != y.shape
                    or not np.isfinite(x).all() or not np.isfinite(y).all() or not np.isfinite(se).all()
                    or np.any(se < 0) or y[0] != 0 or label['worlds'] < report['config']['worlds'] / 2
                    or not 2 <= label['hand'] <= min(hand_limit, report['config']['handLimit'])):
                raise ValueError(f'Invalid teacher label at deal {case["seed"]}')
            mode = case['seatCount']
            groups[mode].append((x, y, se, label['hand']) if include_hand else (x, y, se))
            limits[mode] = max(limits[mode], label['hand'])
    return groups, seeds, limits


def merge_collections(directories):
    combined, used, limits = {5: [], 6: []}, set(), {5: HAND_LIMIT, 6: HAND_LIMIT}
    for directory in directories:
        groups, seeds, hand_limits = read_labels(directory)
        if used & seeds:
            raise ValueError(f'Overlapping deal seeds in {directory}')
        used.update(seeds)
        for n in combined:
            combined[n].extend(groups[n])
            limits[n] = max(limits[n], hand_limits[n])
    return combined, used, limits


def pairs(groups, mean, scale):
    actions, references, targets, weights = [], [], [], []
    for features, advantages, errors in groups:
        normalized = (features - mean) / scale
        actions.append(normalized[1:])
        references.append(np.repeat(normalized[:1], len(features) - 1, axis=0))
        targets.append(advantages[1:])
        # Each position contributes similar weight. A noisy difference receives
        # less weight than a comparison that agrees across sampled hands.
        weights.append(1 / (1 + (errors[1:] / .30) ** 2) / (len(features) - 1))
    return tuple(np.concatenate(parts) for parts in (actions, references, targets, weights))


def fit_linear(data, scale):
    actions, references, y, weight = data
    x = (actions - references).astype(np.float64)
    weighted = x * weight[:, None]
    ridge = .002 * weight.sum() * np.eye(FEATURE_SIZE)
    coefficients = np.linalg.solve(x.T @ weighted + ridge, weighted.T @ y)
    return {'kind': 'linear', 'coefficients': (coefficients / scale).tolist()}


def adam_step(parameters, gradients, first, second, step):
    for index, gradient in enumerate(gradients):
        first[index] = .9 * first[index] + .1 * gradient
        second[index] = .999 * second[index] + .001 * gradient * gradient
        momentum = first[index] / (1 - .9 ** step)
        variance = second[index] / (1 - .999 ** step)
        parameters[index] -= .001 * momentum / (np.sqrt(variance) + 1e-8)


def network_parameters(rng, width=48):
    return [rng.normal(0, 1 / np.sqrt(FEATURE_SIZE), (width, FEATURE_SIZE)).astype(np.float32),
            np.zeros(width, dtype=np.float32), rng.normal(0, .05, width).astype(np.float32)]


def export_network(parameters, mean, scale, epoch, loss_key, loss, output_scale=1.):
    matrix, bias, output = parameters
    weights = matrix / scale
    # Fold feature normalization into the first layer for Node inference.
    return {'kind': 'tanh', 'weights': weights.tolist(), 'bias': (bias - weights @ mean).tolist(),
            'output': (output * output_scale).tolist(), 'epoch': epoch, loss_key: loss}


def fit_network(data, validation, mean, scale, seed):
    rng = np.random.default_rng(seed)
    actions, references, y, weight = data
    parameters = network_parameters(rng)
    first = [np.zeros_like(p) for p in parameters]
    second = [np.zeros_like(p) for p in parameters]
    step = 0
    best_loss, best_epoch, best = float('inf'), 0, None
    va, vr, vy, vw = validation
    for epoch in range(1, 41):
        shuffled = rng.permutation(len(y))
        for begin in range(0, len(y), 256):
            ids = shuffled[begin:begin + 256]
            matrix, bias, output = parameters
            x, baseline = actions[ids], references[ids]
            hx = np.tanh(x @ matrix.T + bias)
            hb = np.tanh(baseline @ matrix.T + bias)
            error = (hx - hb) @ output - y[ids]
            batch_weights = weight[ids]
            derivative = np.clip(error, -.5, .5) * batch_weights / batch_weights.sum()
            dx = derivative[:, None] * output * (1 - hx * hx)
            db = -derivative[:, None] * output * (1 - hb * hb)
            gradients = [dx.T @ x + db.T @ baseline + .0001 * matrix,
                         (dx + db).sum(axis=0), (hx - hb).T @ derivative + .0001 * output]
            step += 1
            adam_step(parameters, gradients, first, second, step)
        matrix, bias, output = parameters
        validation_error = (np.tanh(va @ matrix.T + bias) - np.tanh(vr @ matrix.T + bias)) @ output - vy
        loss = np.average(validation_error ** 2, weights=vw)
        if loss < best_loss:
            best_loss, best_epoch = float(loss), epoch
            best = [p.copy() for p in parameters]
    if best is None:
        raise ValueError('Network training did not produce finite validation loss')
    return export_network(best, mean, scale, best_epoch, 'validationMse', best_loss)


def teacher_targets(groups):
    examples = []
    for features, advantages, errors in groups:
        scores = np.exp((advantages - advantages.max()) / RANK_TEMPERATURE)
        examples.append((features, scores / scores.sum(), 1 / (1 + (errors.max() / .30) ** 2)))
    return examples


def rank_arrays(examples, mean, scale):
    x = np.zeros((len(examples), 8, FEATURE_SIZE), dtype=np.float32)
    legal = np.zeros(x.shape[:2], dtype=bool)
    targets = np.zeros(x.shape[:2], dtype=np.float32)
    weight = np.empty(len(examples), dtype=np.float32)
    for i, (features, target, importance) in enumerate(examples):
        size = len(features)
        x[i, :size] = (features - mean) / scale
        legal[i, :size] = True
        targets[i, :size] = target
        weight[i] = importance
    return x, legal, targets, weight


def rank_log_probs(scores, legal):
    logits = np.where(legal, scores, -np.inf)
    shifted = logits - logits.max(axis=1, keepdims=True)
    return shifted - np.log(np.exp(shifted).sum(axis=1, keepdims=True))


def fit_listwise(groups, validation, mean, scale, seed):
    return fit_ranker(teacher_targets(groups), teacher_targets(validation), mean, scale, seed)


def fit_ranker(examples, validation, mean, scale, seed):
    x, legal, targets, weights = rank_arrays(examples, mean, scale)
    vx, vl, vt, vw = rank_arrays(validation, mean, scale)
    rng = np.random.default_rng(seed)
    parameters = network_parameters(rng)
    first = [np.zeros_like(p) for p in parameters]
    second = [np.zeros_like(p) for p in parameters]
    best_loss, best_epoch, best, step = float('inf'), 0, None, 0
    for epoch in range(1, 41):
        shuffled = rng.permutation(len(x))
        for begin in range(0, len(x), 64):
            ids = shuffled[begin:begin + 64]
            matrix, bias, output = parameters
            batch = x[ids]
            hidden = np.tanh(batch @ matrix.T + bias)
            probabilities = np.exp(rank_log_probs(hidden @ output, legal[ids]))
            batch_weights = weights[ids]
            derivative = (probabilities - targets[ids]) * batch_weights[:, None] / batch_weights.sum()
            flattened = (derivative[..., None] * output * (1 - hidden * hidden)).reshape(-1, len(output))
            gradients = [flattened.T @ batch.reshape(-1, FEATURE_SIZE) + .0001 * matrix,
                         flattened.sum(axis=0), hidden.reshape(-1, len(output)).T @ derivative.ravel() + .0001 * output]
            step += 1
            adam_step(parameters, gradients, first, second, step)
        matrix, bias, output = parameters
        log_probs = rank_log_probs(np.tanh(vx @ matrix.T + bias) @ output, vl)
        loss = np.average(-(vt * np.where(vl, log_probs, 0)).sum(axis=1), weights=vw)
        if loss < best_loss:
            best_loss, best_epoch, best = float(loss), epoch, [p.copy() for p in parameters]
    if best is None:
        raise ValueError('Ranking training did not produce finite validation loss')
    return export_network(best, mean, scale, best_epoch, 'validationCrossEntropy', best_loss, RANK_TEMPERATURE)


def measure(policy, groups):
    changes, agreements, regret, reference_regret = 0, 0, 0., 0.
    if policy['kind'] == 'linear':
        weights = np.asarray(policy['coefficients'])
        score = lambda x: x @ weights
    else:
        weights = np.asarray(policy['weights'])
        bias, output = np.asarray(policy['bias']), np.asarray(policy['output'])
        score = lambda x: np.tanh(x @ weights.T + bias) @ output
    for x, target, _ in groups:
        values = score(x)
        choice = int(np.argmax(values))
        if values[choice] - values[0] <= policy['margin']:
            choice = 0
        best = float(target.max())
        loss = best - float(target[choice])
        changes += choice != 0
        agreements += loss <= 1e-6
        regret += loss
        reference_regret += best
    size = len(groups)
    return {'positions': size, 'changes': changes, 'teacherAgreement': agreements / size,
            'meanTeacherRegret': regret / size, 'rulesTeacherRegret': reference_regret / size}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--train', action='append', type=Path)
    parser.add_argument('--validation', required=True, action='append', type=Path)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--measure', type=Path, help='Score a fixed student on independent teacher labels')
    parser.add_argument('--listwise', action='store_true', help='Train against the teacher distribution across all legal candidates')
    parser.add_argument('--seed', default=1121, type=int)
    args = parser.parse_args()
    validation, validation_seeds, _ = merge_collections(args.validation)
    if min(map(len, validation.values())) < 2:
        parser.error('Each validation mode needs at least two labelled positions')
    if args.measure:
        model = json.loads(args.measure.read_text(encoding='utf8'))
        used = set(model['metadata']['trainingSeeds']) | set(model['metadata']['selectionSeeds'])
        if used & validation_seeds:
            parser.error('Measurement overlaps training or selection')
        report = {n: measure(model['models'][str(n)], validation[n]) for n in model['seatCounts']}
        with args.out.open('x', encoding='utf8') as file:
            json.dump(report, file, indent=2, allow_nan=False)
        print(json.dumps(report))
        return
    if not args.train:
        parser.error('Provide --train for each collection directory')
    training, training_seeds, hand_limits = merge_collections(args.train)
    if training_seeds & validation_seeds:
        parser.error('Training collections overlap validation seeds')
    if min(map(len, training.values())) < 2:
        parser.error('Each mode needs at least two training positions')
    args.out.mkdir(parents=True, exist_ok=False)
    learned = {}
    for n, groups in training.items():
        features = np.concatenate([group[0] for group in groups])
        mean = features.mean(axis=0)
        scale = np.maximum(features.std(axis=0), .05)
        if args.listwise:
            learned[n] = {'listwise': fit_listwise(groups, validation[n], mean, scale, args.seed + n)}
        else:
            data = pairs(groups, mean, scale)
            heldout = pairs(validation[n], mean, scale)
            learned[n] = {'linear': fit_linear(data, scale), 'network': fit_network(data, heldout, mean, scale, args.seed + n)}
        network = learned[n]['listwise' if args.listwise else 'network']
        print(json.dumps({'players': n, 'trainingPositions': len(groups), 'networkEpoch': network['epoch']}), flush=True)
    source = 'Listwise distillation of PIMC labels' if args.listwise else 'Supervised paired advantage regression on PIMC labels'
    metadata = {'trainingSeeds': sorted(training_seeds), 'selectionSeeds': sorted(validation_seeds),
                'trainingPositions': {n: len(groups) for n, groups in training.items()},
                'validationPositions': {n: len(groups) for n, groups in validation.items()},
                'source': source}
    candidates = []
    for kind in learned[5]:
        for margin in MARGINS:
            models = {n: {**learned[n][kind], 'margin': margin, 'handLimit': hand_limits[n]} for n in (5, 6)}
            candidates.append({'id': f'{kind}-{margin:g}', 'model': {'schema': SCHEMA, 'featureSize': FEATURE_SIZE,
                               'handLimit': max(hand_limits.values()), 'seatCounts': [5, 6], 'models': models, 'metadata': metadata},
                               'labelValidation': {n: measure(models[n], validation[n]) for n in (5, 6)}})
    (args.out / 'candidates.json').write_text(json.dumps(candidates, allow_nan=False), encoding='utf8')


if __name__ == '__main__':
    main()
