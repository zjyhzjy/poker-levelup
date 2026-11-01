import unittest
import json
import pathlib
import shutil
import subprocess
import tempfile
import numpy as np
from train import Network, OBSERVATION_SIZE, ACTION_SIZE


class TrainingTests(unittest.TestCase):
    def batch(self):
        rng=np.random.default_rng(42)
        return (rng.normal(0,.1,(3,OBSERVATION_SIZE)).astype(np.float32),
                rng.normal(0,.1,(3,ACTION_SIZE)).astype(np.float32),
                np.array([1.,-1.,0.],np.float32),
                rng.uniform(0,1,(3,378)).astype(np.float32),
                rng.integers(0,2,(3,378)).astype(np.float32),
                np.array([[-1,1,4,5,2,-1],[-1,2,2,3,4,5],[-1,-1,-1,-1,-1,-1]]))

    def test_gradients(self):
        model=Network(hidden=4,action_hidden=4)
        batch=self.batch()
        _,grad,_=model.loss_grad(batch)
        for name in model.p:
            index=np.unravel_index(np.argmax(np.abs(grad[name])),grad[name].shape)
            original=model.p[name][index].copy()
            epsilon=.001
            model.p[name][index]=original+epsilon
            plus=model.loss_grad(batch)[0]
            model.p[name][index]=original-epsilon
            minus=model.loss_grad(batch)[0]
            model.p[name][index]=original
            numeric=(plus-minus)/(2*epsilon)
            self.assertAlmostEqual(float(grad[name][index]),numeric,delta=.002,msg=name)

    def test_training_reduces_loss(self):
        model=Network(hidden=8,action_hidden=8)
        batch=self.batch()
        before=model.loss_grad(batch)[0]
        for _ in range(60):
            _,grad,_=model.loss_grad(batch)
            model.update(grad,.01)
        self.assertLess(model.loss_grad(batch)[0],before*.5)

    def test_missing_behavior_targets_are_masked(self):
        model=Network(hidden=4,action_hidden=4)
        batch=list(self.batch())
        batch[-1].fill(-1)
        loss,grad,metrics=model.loss_grad(batch)
        self.assertTrue(np.isfinite(loss))
        self.assertEqual(metrics['behavior_ce'],0)
        self.assertTrue(np.all(grad['behaviorW']==0))

    @unittest.skipUnless(shutil.which('node'), 'Node.js required for inference parity')
    def test_export_matches_node_inference(self):
        model=Network(hidden=4,action_hidden=4)
        x,a,*_=self.batch()
        expected=model.forward(x,a)[3]
        module=(pathlib.Path(__file__).resolve().parents[2]/'src/ai/learning/network.js').as_uri()
        code=f'''import fs from 'node:fs';
import {{validateModel,scoreActions,predictAuxiliary}} from {json.dumps(module)};
const d=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
validateModel(d.model);
console.log(JSON.stringify(d.x.map((x,i)=>({{q:scoreActions(d.model,x,[d.a[i]])[0],aux:predictAuxiliary(d.model,x)}}))));'''
        with tempfile.TemporaryDirectory() as directory:
            data=pathlib.Path(directory)/'parity.json'
            data.write_text(json.dumps({'model':model.export(),'x':x.tolist(),'a':a.tolist()}),encoding='utf8')
            result=subprocess.run([shutil.which('node'),'--input-type=module','-e',code,str(data)],capture_output=True,text=True,check=True)
        actual=json.loads(result.stdout)
        np.testing.assert_allclose([v['q'] for v in actual],expected,atol=1e-6)
        _,_,_,_,_,belief,probs=model.forward(x,a)
        np.testing.assert_allclose([v['aux']['expectedCounts'] for v in actual],(belief*3).reshape(3,7,54),atol=1e-6)
        np.testing.assert_allclose([v['aux']['nextActionProbabilities'] for v in actual],probs,atol=1e-6)


if __name__=='__main__':
    unittest.main()
