"""CPU reference implementation of multi-task deep Monte-Carlo policy iteration.

Only NumPy is needed. Training labels may contain simulator-private cards;
the encoder and the exported Node policy take exclusively information-set inputs.
This is a reproducible small-model baseline, not a claim of optimal play.
"""
import os
os.environ.setdefault('OPENBLAS_NUM_THREADS', '2')
os.environ.setdefault('OMP_NUM_THREADS', '2')
os.environ.setdefault('MKL_NUM_THREADS', '2')
import argparse
import json
import gzip
import pathlib
import shutil
import subprocess
import sys
import numpy as np

SCHEMA = 'shengji-information-set-v1'
OBSERVATION_SIZE, ACTION_SIZE = 1014, 74
PARAMS = ('encoderW', 'encoderB', 'qW', 'qB', 'valueW', 'valueB',
          'beliefW', 'beliefB', 'behaviorW', 'behaviorB')


class Network:
    def __init__(self, seed=1, hidden=32, action_hidden=32):
        self.rng = np.random.default_rng(seed)
        self.p = {}
        for name, inputs, outputs in [('encoder', OBSERVATION_SIZE, hidden),
                                     ('q', hidden + ACTION_SIZE, action_hidden),
                                     ('value', action_hidden, 1),
                                     ('belief', hidden, 378), ('behavior', hidden, 48)]:
            self.p[name+'W'] = (self.rng.normal(size=(outputs, inputs)) * np.sqrt(1/inputs)).astype(np.float32)
            self.p[name+'B'] = np.zeros(outputs, dtype=np.float32)
        # Hidden-card occupancy is sparse; a neutral near-zero start is useful.
        self.p['beliefB'].fill(-2)
        self.m = {k: np.zeros_like(v) for k, v in self.p.items()}
        self.v = {k: np.zeros_like(v) for k, v in self.p.items()}
        self.step = 0

    def forward(self, x, a):
        p = self.p
        h = np.tanh(x @ p['encoderW'].T + p['encoderB'])
        joined = np.concatenate((h, a), axis=1)
        z = np.tanh(joined @ p['qW'].T + p['qB'])
        q = (z @ p['valueW'].T + p['valueB'])[:, 0]
        bl = h @ p['beliefW'].T + p['beliefB']
        b = 1 / (1 + np.exp(-np.clip(bl, -40, 40)))
        pl = (h @ p['behaviorW'].T + p['behaviorB']).reshape(-1, 6, 8)
        pl = pl - pl.max(axis=2, keepdims=True)
        probs = np.exp(pl)
        probs /= probs.sum(axis=2, keepdims=True)
        return h, joined, z, q, bl, b, probs

    def loss_grad(self, batch, belief_weight=.2, behavior_weight=.1):
        x, a, y, target, mask, labels = batch
        h, joined, z, q, bl, belief, probs = self.forward(x, a)
        qloss = np.mean((q-y)**2)
        denom = max(1, mask.sum())
        bloss = np.sum((np.logaddexp(0, bl) - target*bl)*mask)/denom
        valid = labels >= 0
        safe = np.maximum(labels, 0)
        correct = np.take_along_axis(probs, safe[..., None], axis=2)[..., 0]
        pdenom = max(1, valid.sum())
        ploss = -np.sum(np.log(np.maximum(correct, 1e-12))*valid)/pdenom
        dq = (2*(q-y)/len(q))[:, None]
        g = {'valueW': dq.T @ z, 'valueB': dq.sum(axis=0)}
        dz = (dq @ self.p['valueW'])*(1-z*z)
        g.update(qW=dz.T @ joined, qB=dz.sum(axis=0))
        dh = (dz @ self.p['qW'])[:, :h.shape[1]]
        db = belief_weight*(belief-target)*mask/denom
        g.update(beliefW=db.T @ h, beliefB=db.sum(axis=0))
        dh += db @ self.p['beliefW']
        dp = probs.copy()
        rows, seats = np.indices(labels.shape)
        dp[rows, seats, safe] -= 1
        dp *= (behavior_weight*valid/pdenom)[..., None]
        dp = dp.reshape(-1, 48)
        g.update(behaviorW=dp.T @ h, behaviorB=dp.sum(axis=0))
        dh += dp @ self.p['behaviorW']
        dh *= 1-h*h
        g.update(encoderW=dh.T @ x, encoderB=dh.sum(axis=0))
        metrics = {'q_mse':float(qloss), 'belief_bce':float(bloss), 'behavior_ce':float(ploss)}
        return float(qloss+belief_weight*bloss+behavior_weight*ploss), g, metrics

    def update(self, gradients, lr):
        norm = np.sqrt(sum(float(np.sum(g*g)) for g in gradients.values()))
        if not np.isfinite(norm):
            raise ValueError('Non-finite training gradient')
        scale = min(1., 5/max(norm, 1e-12))
        self.step += 1
        for k, gradient in gradients.items():
            g = gradient*scale
            self.m[k] = .9*self.m[k]+.1*g
            self.v[k] = .999*self.v[k]+.001*g*g
            mh = self.m[k]/(1-.9**self.step)
            vh = self.v[k]/(1-.999**self.step)
            self.p[k] -= lr*mh/(np.sqrt(vh)+1e-8)

    def export(self, metadata=None):
        return {'schema':SCHEMA, 'observationSize':OBSERVATION_SIZE, 'actionSize':ACTION_SIZE,
                'hiddenSize':len(self.p['encoderB']), 'actionHiddenSize':len(self.p['qB']),
                'seatCounts':[5,6], 'metadata':metadata or {}, **{k:v.tolist() for k,v in self.p.items()}}

    @classmethod
    def from_checkpoint(cls, checkpoint, seed=1):
        if (checkpoint.get('schema') != SCHEMA or checkpoint.get('observationSize') != OBSERVATION_SIZE
                or checkpoint.get('actionSize') != ACTION_SIZE or checkpoint.get('seatCounts') != [5,6]):
            raise ValueError('Incompatible checkpoint')
        model=cls(seed, checkpoint['hiddenSize'], checkpoint['actionHiddenSize'])
        for name in PARAMS:
            value=np.asarray(checkpoint[name], dtype=np.float32)
            if value.shape != model.p[name].shape or not np.isfinite(value).all():
                raise ValueError('Invalid checkpoint parameter '+name)
            model.p[name]=value
        return model


def load_live_rounds(manifest):
    rows=[]
    files=json.loads(pathlib.Path(manifest).read_text(encoding='utf8'))
    if not isinstance(files,list) or len(files)>100:
        raise ValueError('Invalid live-round manifest')
    for file in files:
        # Bound decompression before parsing; never accept arbitrary huge replay blobs.
        with gzip.open(file,'rb') as stream:
            raw=stream.read(4*1024*1024+1)
        if len(raw)>4*1024*1024:
            raise ValueError('Oversized live round')
        record=json.loads(raw)
        if (record.get('schema')!=SCHEMA or record.get('recordType')!='completed-live-round-v1'
                or record.get('seatCount') not in (5,6) or record.get('humanActions',0)<1):
            raise ValueError('Not a complete supported human round')
        samples=record['samples']
        if not 1<=len(samples)<=200:
            raise ValueError('Invalid round length')
        data=arrays(samples)
        for i,width in [(0,OBSERVATION_SIZE),(1,ACTION_SIZE),(3,378),(4,378),(5,6)]:
            if data[i].shape!=(len(samples),width):raise ValueError('Invalid live sample shape')
        if not all(np.isfinite(a).all() for a in data):raise ValueError('Non-finite live sample')
        if ((data[5]<-1)|(data[5]>7)).any():raise ValueError('Invalid behavior target')
        rows.extend(samples)
    return rows,len(files)


def arrays(samples):
    names = ['observation', 'action', 'reward', 'belief', 'beliefMask', 'behavior']
    return tuple(np.asarray([s[k] for s in samples], dtype=np.int64 if k=='behavior' else np.float32) for k in names)


def save_json(path, data):
    temporary = path.with_suffix(path.suffix+'.tmp')
    temporary.write_text(json.dumps(data, allow_nan=False, separators=(',', ':')), encoding='utf8')
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--iterations', type=int, default=4)
    parser.add_argument('--games', type=int, default=64, help='Even number per iteration, half 5-player / half 6-player')
    parser.add_argument('--epochs', type=int, default=3)
    parser.add_argument('--batch-size', type=int, default=128)
    parser.add_argument('--seed', type=int, default=1121)
    parser.add_argument('--hidden', type=int, default=32)
    parser.add_argument('--lr', type=float, default=.001)
    parser.add_argument('--sample-rate', type=float, default=.25)
    parser.add_argument('--out', default='.run/learning')
    parser.add_argument('--node', default=shutil.which('node') or 'node')
    parser.add_argument('--init', help='Warm-start weights; optimizer is intentionally reset')
    parser.add_argument('--live-manifest', help='JSON list of completed anonymous .json.gz rounds')
    args = parser.parse_args()
    if (args.iterations<1 or args.games<2 or args.games%2 or args.epochs<1 or args.batch_size<1
            or not 0<args.sample_rate<=1 or not 1<=args.hidden<=512 or not np.isfinite(args.lr) or args.lr<=0
            or args.seed<0 or args.seed+(args.iterations-1)*10000000+(args.games-1)*7919>0xffffffff):
        parser.error('iterations/epochs/batch must be positive; games even >=2; 0 < sample-rate <= 1')
    root = pathlib.Path(__file__).resolve().parents[2]
    out = pathlib.Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    candidate = out/'candidate.json'
    if candidate.exists():
        parser.error('Output already has a candidate.json; choose a fresh --out directory to preserve existing training')
    checkpoint=json.loads(pathlib.Path(args.init).read_text(encoding='utf8')) if args.init else None
    model = Network.from_checkpoint(checkpoint,args.seed) if checkpoint else Network(args.seed, args.hidden)
    live,live_rounds=load_live_rounds(args.live_manifest) if args.live_manifest else ([],0)
    inherited=checkpoint.get('metadata',{}).get('trainingSeeds',[]) if checkpoint else []
    history, replay, seeds = [], [], list(inherited)
    for iteration in range(args.iterations):
        data_path = out/f'rollout-{iteration:03}.jsonl'
        iteration_seed = args.seed+iteration*10000000
        command = [args.node, str(root/'bench/learning/rollout.mjs'), '--games', str(args.games),
                   '--seed', str(iteration_seed), '--sample-rate', str(args.sample_rate),
                   '--out', str(data_path), '--epsilon', str(max(.05, .25/(1+iteration)))]
        if iteration or args.init:
            command += ['--model', str(candidate if iteration else pathlib.Path(args.init).resolve())]
        if iteration>1:
            command += ['--previous', str(out/f'checkpoint-{iteration-2:03}.json')]
        result = subprocess.run(command, cwd=root, check=True, capture_output=True, text=True)
        rollout = json.loads(result.stdout.strip())
        current = [json.loads(line) for line in data_path.read_text(encoding='utf8').splitlines()]
        if not current:
            raise ValueError('Empty rollout')
        seeds += [iteration_seed+i*7919 for i in range(args.games)]
        replay.append(current)
        replay = replay[-3:]
        simulated=[s for chunk in replay for s in chunk]
        # Real-world trajectories are capped at 40% of examples, so a small group
        # of players cannot completely replace self-play in the training distribution.
        live_count=min(len(live),int(len(simulated)*2/3))
        selected=[live[i] for i in model.rng.choice(len(live),live_count,replace=False)] if live_count else []
        data = arrays(simulated+selected)
        for _ in range(args.epochs):
            order = model.rng.permutation(len(data[0]))
            for start in range(0, len(order), args.batch_size):
                ids = order[start:start+args.batch_size]
                _, gradients, metrics = model.loss_grad(tuple(a[ids] for a in data))
                model.update(gradients, args.lr)
        # Report complete current-batch loss rather than cherry-picking a minibatch.
        current_data = arrays(current)
        _, _, metrics = model.loss_grad(current_data)
        history.append({'iteration':iteration, **rollout, **metrics})
        metadata = {'algorithm':'multi-task deep Monte-Carlo policy iteration', 'experimental':True,
                    'trainingSeeds':seeds, 'iterations':history, 'seed':args.seed,
                    'games':args.games*(iteration+1), 'optimizerSteps':model.step,
                    'liveRounds':live_rounds,'liveExamplesAvailable':len(live),'liveExamplesThisIteration':live_count,
                    'scope':'play phase only; bounded engine candidates; no optimality or strength guarantee'}
        save_json(candidate, model.export(metadata))
        save_json(out/f'checkpoint-{iteration:03}.json', model.export(metadata))
        save_json(out/'training-report.json', metadata)
        print(json.dumps(history[-1]), flush=True)
    print(f'Experimental candidate saved: {candidate}', flush=True)


if __name__ == '__main__':
    main()
