// Bounded offline policy iteration. No production model is installed here.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';
import {validateModel} from '../../src/ai/learning/network.js';
import {evaluate} from './evaluate.mjs';
import {compareIncumbent,promotionGate} from './promotion.mjs';

const modes=[5,6];
export function selectDevelopment(rows, reference) {
  if(!rows.includes(reference))throw new Error('Reference must be retained in selection');
  for(const row of rows)for(const n of modes) {
    if(!Number.isFinite(row.report?.modes?.[n]?.meanNetLevelDelta))throw new Error('Invalid development result');
  }
  // Avoid accepting a development-set regression in either supported mode.
  const eligible=rows.filter(row=>modes.every(n=>row.report.modes[n].meanNetLevelDelta>=reference.report.modes[n].meanNetLevelDelta));
  return eligible.reduce((best,row)=>{
    const score=r=>Math.min(...modes.map(n=>r.report.modes[n].meanNetLevelDelta));
    return score(row)>score(best)?row:best;
  },reference);
}

const loadModel=file=>validateModel(JSON.parse(fs.readFileSync(file,'utf8')));
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const seedList=(base,count)=>Array.from({length:count},(_,i)=>base+i*7919);

async function main() {
  const {values:v}=parseArgs({options:{out:{type:'string'},init:{type:'string'},python:{type:'string'},
    seed:{type:'string',default:'500001121'}}});
  if(!v.out||!v.init||!v.python)throw new Error('--out, --init and --python are required');
  const root=fileURLToPath(new URL('../../',import.meta.url)),out=path.resolve(v.out),init=path.resolve(v.init),seed=Number(v.seed);
  if(!Number.isSafeInteger(seed)||seed<0||seed+2800000000+23*7919>0xffffffff)throw new Error('Invalid seed range');
  const initial=loadModel(init),initialBytes=fs.readFileSync(init);
  const configs=[{label:'stable',lr:.0001,beliefWeight:.2,behaviorWeight:.1},
    {label:'reward',lr:.00015,beliefWeight:0,behaviorWeight:0}];
  const blocks=Array.from({length:5},(_,i)=>({seed:seed+i*80000000,games:2048,iterations:4}));
  const planned=blocks.flatMap(b=>Array.from({length:4},(_,j)=>seedList(b.seed+j*10000000,512)).flat());
  const evaluation={development:{seed:seed+900000000,deals:32},hard:{seed:seed+1900000000,deals:128},
    previous:{seed:seed+2200000000,deals:80},random:{seed:seed+2500000000,deals:40},
    auxiliary:{seed:seed+2800000000,deals:24}};
  const inherited=new Set([...(initial.metadata?.trainingSeeds||[]),...(initial.metadata?.selectionSeeds||[])]);
  const allSeeds=new Set(planned);
  if(allSeeds.size!==10240||planned.some(s=>inherited.has(s)))throw new Error('Training seed reuse');
  for(const e of Object.values(evaluation))for(const s of seedList(e.seed,e.deals)) {
    if(allSeeds.has(s)||inherited.has(s))throw new Error('Training/selection/test seed overlap');
    allSeeds.add(s);
  }
  fs.mkdirSync(out,{recursive:true});
  const manifestFile=path.join(out,'iteration-run.json');
  if(fs.existsSync(manifestFile))throw new Error('Use a fresh output directory');
  try{os.setPriority(process.pid,os.constants.priority.PRIORITY_BELOW_NORMAL);}catch{}
  const save=(name,data)=>{
    const file=path.join(out,name+'.json'),temp=file+'.tmp';
    fs.writeFileSync(temp,JSON.stringify(data,null,2));fs.renameSync(temp,file);
  };
  const log=data=>console.log(JSON.stringify({at:new Date().toISOString(),...data}));
  const manifest={schema:'shengji-offline-iteration-v1',startedAt:new Date().toISOString(),complete:false,
    plannedTrainingGames:10240,trainingByMode:{5:5120,6:5120},init,initialSha256:sha(initialBytes),
    seed,blocks,configs,evaluation,python:v.python,node:process.execPath,stages:[],
    selectionCriterion:'Retain reference on ties or any per-mode development regression; otherwise maximize the weaker mode mean. Fresh final tests do not select checkpoints.',
    promoted:false,parentPid:process.pid};
  save('iteration-run',manifest);fs.writeFileSync(path.join(out,'initial-model.json'),initialBytes);
  async function train(label,block,start,config) {
    const directory=path.join(out,label),logFile=path.join(out,label+'.log');
    const fd=fs.openSync(logFile,'wx');
    const args=['-u',path.join(root,'bench/learning/train.py'),'--iterations','4','--games','512',
      '--epochs','3','--batch-size','256','--sample-rate','.35','--lr',String(config.lr),
      '--belief-weight',String(config.beliefWeight),'--behavior-weight',String(config.behaviorWeight),
      '--seed',String(block.seed),'--init',start,'--node',process.execPath,'--out',directory];
    log({phase:'training-start',label,seed:block.seed,config});
    const child=spawn(v.python,args,{cwd:root,windowsHide:true,stdio:['ignore',fd,fd],
      env:{...process.env,OPENBLAS_NUM_THREADS:'1',OMP_NUM_THREADS:'1',MKL_NUM_THREADS:'1'}});
    fs.closeSync(fd);
    try{os.setPriority(child.pid,os.constants.priority.PRIORITY_BELOW_NORMAL);}catch{}
    save('process-'+label,{label,pid:child.pid,args,startedAt:new Date().toISOString()});
    await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(`${label} exited ${code}; see ${logFile}`)));});
    const metadata=JSON.parse(fs.readFileSync(path.join(directory,'training-report.json'),'utf8'));
    if(metadata.games!==2048)throw new Error('Incomplete training block');
    const row={label,modelPath:path.join(directory,'candidate.json'),config,blockSeed:block.seed,
      games:metadata.games,samples:metadata.iterations.reduce((s,i)=>s+i.samples,0),
      moves:metadata.iterations.reduce((s,i)=>s+i.moves,0),optimizerSteps:metadata.optimizerSteps};
    manifest.stages.push(row);save('iteration-run',manifest);log({phase:'training-complete',label,games:2048});
    return row;
  }
  const development=[];
  function assess(label,modelPath,config) {
    const report=evaluate({model:loadModel(modelPath),seeds:evaluation.development.deals,seed:evaluation.development.seed});
    const row={label,modelPath,config,report};development.push(row);save('development',development);
    log({phase:'development',label,means:Object.fromEntries(modes.map(n=>[n,report.modes[n].meanNetLevelDelta]))});return row;
  }
  // Exploration uses separate rollout seeds; both arms start with identical weights.
  const jobs=configs.map((c,i)=>train('explore-'+c.label,blocks[i],init,c));
  let best=assess('previous',init,null);
  const explored=await Promise.allSettled(jobs);
  const failed=explored.filter(r=>r.status==='rejected');
  if(failed.length)throw failed[0].reason;
  const arms=explored.map(r=>assess(r.value.label,r.value.modelPath,r.value.config));
  best=selectDevelopment([best,...arms],best);
  const ranked=[...arms].sort((a,b)=>Math.min(...modes.map(n=>b.report.modes[n].meanNetLevelDelta))-Math.min(...modes.map(n=>a.report.modes[n].meanNetLevelDelta)));
  let config={...(best.config||ranked[0].config)};
  save('current-best',{...best,continuedConfig:config});
  for(let i=0;i<3;i++) {
    const label='refine-'+(i+1),trained=await train(label,blocks[i+2],best.modelPath,config);
    const next=assess(label,trained.modelPath,config),previous=best;
    best=selectDevelopment([previous,next],previous);
    const accepted=best===next;
    log({phase:'stage-decision',label,accepted,retained:best.label});
    if(!accepted)config={...config,lr:Math.max(.000025,config.lr/2)};
    save('current-best',{...best,continuedConfig:config});
  }
  const selected=loadModel(best.modelPath);
  selected.metadata={...selected.metadata,
    selectionSeeds:[...new Set([...(selected.metadata?.selectionSeeds||[]),...seedList(evaluation.development.seed,evaluation.development.deals)])],
    offlineIteration:{run:path.basename(out),trainingGamesAttempted:10240,selectedStage:best.label,
      scope:'Bounded play-phase policy iteration; best tested candidate, no optimality guarantee.'}};
  const selectedBytes=Buffer.from(JSON.stringify(selected));
  fs.writeFileSync(path.join(out,'selected-model.json'),selectedBytes);
  save('selection',{selectedStage:best.label,source:best.modelPath,sha256:sha(selectedBytes),development:best.report,
    selectedTrainingSeedCount:(selected.metadata.trainingSeeds||[]).length});
  log({phase:'final-hard',dealsPerMode:evaluation.hard.deals});
  const hard=evaluate({model:selected,seeds:evaluation.hard.deals,seed:evaluation.hard.seed});save('evaluation-hard',hard);
  log({phase:'final-vs-previous',dealsPerMode:evaluation.previous.deals});
  const previous=compareIncumbent({candidate:selected,incumbent:initial,seeds:evaluation.previous.deals,seed:evaluation.previous.seed,
    onProgress:p=>{if(p.completedDeals%16===0)log({phase:'vs-previous-progress',...p});}});save('evaluation-vs-previous',previous);
  log({phase:'final-random',dealsPerMode:evaluation.random.deals});
  const random=evaluate({model:selected,seeds:evaluation.random.deals,seed:evaluation.random.seed,opponent:'random'});save('evaluation-random',random);
  const floor=promotionGate({hard,incumbent:hard});
  const result={complete:true,trainingGames:manifest.stages.reduce((s,r)=>s+r.games,0),trainingByMode:manifest.trainingByMode,
    selectedStage:best.label,sha256:sha(selectedBytes),selectedTrainingSeedCount:(selected.metadata.trainingSeeds||[]).length,
    hard,vsPrevious:previous,random,hardFloor:floor,promoted:false,
    promotionReason:floor.accepted?'Needs independent default-master-PIMC comparison before promotion':'Hard baseline prerequisite not met',
    limitations:'Adaptive selection uses a reused development set. Final tests are fresh and cannot choose a different checkpoint. Single-seat net-level deltas, not win rates, human strength, or proof of optimality.'};
  if(result.trainingGames!==10240)throw new Error('Incorrect training budget');
  save('final-result',result);manifest.complete=true;manifest.completedAt=new Date().toISOString();save('iteration-run',manifest);
  log({phase:'complete',trainingGames:10240,selectedStage:best.label,hardFloorAccepted:floor.accepted,promoted:false});
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main().catch(error=>{console.error(error);process.exitCode=1;});
}
