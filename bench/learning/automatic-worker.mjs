import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {validateModel} from '../../src/ai/learning/network.js';
import {atomicJson,sha256} from '../../src/ai/learning/automatic.js';
import {evaluate} from './evaluate.mjs';
import {compareIncumbent,promotionGate} from './promotion.mjs';

const job=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
const {root,runDir,directory}=job;
const progress=value=>atomicJson(path.join(runDir,'progress.json'),{...value,updatedAt:new Date().toISOString()});
async function train(args) {
  await new Promise((resolve,reject)=>{
    const child=spawn(job.python,args,{cwd:root,windowsHide:true,stdio:'inherit',
      env:{...process.env,OPENBLAS_NUM_THREADS:'1',OMP_NUM_THREADS:'1',MKL_NUM_THREADS:'1'}});
    const timer=setTimeout(()=>{child.kill();reject(new Error('Training exceeded two-hour limit'));},2*3600000);
    child.once('error',e=>{clearTimeout(timer);reject(e);});
    child.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(new Error(`Training exited ${code}`));});
  });
}
let lease;
try {
  // Cross-process exclusion, independent of the server's in-memory queue.
  lease=await fs.open(path.join(directory,'worker.lock'),'wx');
  await lease.writeFile(JSON.stringify({pid:process.pid,runDir}));
  await progress({phase:'training'});
  const output=path.join(runDir,'training');
  const args=[path.join(root,'bench/learning/train.py'),'--iterations','2','--games','32','--epochs','3',
    '--seed',String(crypto.randomInt(1,100000000)),'--out',output,'--node',process.execPath,
    '--live-manifest',path.join(runDir,'live-manifest.json')];
  if(job.initModel)args.push('--init',job.initModel);
  await train(args);
  const candidateBytes=await fs.readFile(path.join(output,'candidate.json'));
  const candidate=validateModel(JSON.parse(candidateBytes));
  const incumbent=job.incumbent?validateModel(JSON.parse(await fs.readFile(job.incumbent,'utf8'))):null;
  const used=new Set([...(candidate.metadata?.trainingSeeds||[]),...(incumbent?.metadata?.trainingSeeds||[])]);
  let seed;
  do{seed=crypto.randomInt(500000000,3000000000);}while(Array.from({length:job.evalSeeds},(_,i)=>seed+i*7919).some(s=>used.has(s)));
  await progress({phase:'evaluating-hard',seed});
  const hard=evaluate({model:candidate,seeds:job.evalSeeds,seed});
  await atomicJson(path.join(runDir,'evaluation-hard.json'),hard);
  // A candidate that fails the cheap floor cannot be promoted. Avoid hours of
  // PIMC comparison when it already fails a prerequisite.
  const floor=promotionGate({hard,incumbent:hard});
  let reports={hard},gate=floor;
  if(floor.accepted) {
    await progress({phase:'evaluating-incumbent'});
    const old=compareIncumbent({candidate,incumbent,seeds:job.evalSeeds,seed:seed+1000000,masterOptions:job.masterOptions,
      onProgress:p=>console.log(JSON.stringify({phase:'evaluating-incumbent',...p}))});
    reports.incumbent=old;gate=promotionGate(reports);
    await atomicJson(path.join(runDir,'evaluation-incumbent.json'),old);
  }
  let promoted=false;
  if(gate.accepted) {
    const activePath=path.join(directory,'active.json');
    const existing=await fs.readFile(activePath).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if((existing?sha256(existing):null)!==job.expectedActiveDigest)throw new Error('Incumbent changed while training; refusing stale promotion');
    const hash=sha256(candidateBytes);await fs.mkdir(path.join(directory,'models'),{recursive:true});
    await fs.writeFile(path.join(directory,'models',`${hash}.json`),candidateBytes,{flag:'wx'}).catch(e=>{if(e.code!=='EEXIST')throw e;});
    const previous=existing?JSON.parse(existing):null;
    await atomicJson(activePath,{sha256:hash,previous:previous?.sha256||null,runId:path.basename(runDir),approvedAt:new Date().toISOString(),gate});
    promoted=true;
  }
  await atomicJson(path.join(runDir,'result.json'),{ok:true,promoted,gate,modelHash:sha256(candidateBytes)});
  await progress({phase:promoted?'approved-for-new-rounds':'rejected-keep-incumbent'});
}catch(error) {
  await atomicJson(path.join(runDir,'result.json'),{ok:false,promoted:false,error:error.message});
  console.error(error);process.exitCode=1;
}finally {
  if(lease){await lease.close();await fs.unlink(path.join(directory,'worker.lock')).catch(()=>{});}
  // Round snapshots are only needed while training. The original bounded store
  // remains available; do not retain a second unbounded copy of live game data.
  for(const name of await fs.readdir(path.join(runDir,'rounds')).catch(()=>[])) {
    if(/^[0-9a-f-]+\.json\.gz$/.test(name))await fs.unlink(path.join(runDir,'rounds',name)).catch(()=>{});
  }
}
