import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import os from 'node:os';
import {RoundRecorder} from './recorder.js';
import {validateModel} from './network.js';

export const sha256=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
export async function atomicJson(file,value) {
  await fs.mkdir(path.dirname(file),{recursive:true});
  const temp=file+`.${crypto.randomUUID()}.tmp`;
  try {await fs.writeFile(temp,JSON.stringify(value,null,2),{mode:0o600});await fs.rename(temp,file);}
  finally {await fs.unlink(temp).catch(()=>{});}
}
async function readJson(file,fallback=null){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}

export class AutomaticLearning {
  constructor({root,directory=path.join(root,'.data/learning'),python='python',initModel=null,
    fallbackModel=null,fallbackPath=null,minRounds=20,cooldownMs=6*3600000,evalSeeds=24,onError=console.error}) {
    if(!Number.isInteger(minRounds)||minRounds<1||!Number.isInteger(evalSeeds)||evalSeeds<24||cooldownMs<60000)throw new Error('Invalid automatic learning configuration');
    Object.assign(this,{root,directory,python,initModel,fallbackModel,fallbackPath,minRounds,cooldownMs,evalSeeds,onError});
    this.roundPins=new WeakMap();this.current=fallbackModel;this.active=null;this.checking=false;
    this.recorder=new RoundRecorder({directory:path.join(directory,'rounds'),onSaved:()=>this.tick(),onError});
  }
  async start({timer=true}={}) {
    await fs.mkdir(this.directory,{recursive:true});
    this.state=await readJson(path.join(this.directory,'state.json'),{processed:[],lastCompleted:0,failures:0});
    await this.refreshModel();
    await this.tick();
    if(timer){this.timer=setInterval(()=>this.tick().catch(this.onError),60000);this.timer.unref();}
    return this;
  }
  attach(room){this.recorder.attach(room);}
  pin(room){this.roundPins.set(room,{round:room.round,model:this.current});}
  modelFor(room){const pin=this.roundPins.get(room);return pin?.round===room.round?pin.model:this.fallbackModel;}
  async refreshModel() {
    const manifest=await readJson(path.join(this.directory,'active.json'));
    if(!manifest||manifest.sha256===this.active?.sha256)return;
    if(!/^[a-f0-9]{64}$/.test(manifest.sha256))throw new Error('Invalid approved model hash');
    const bytes=await fs.readFile(path.join(this.directory,'models',`${manifest.sha256}.json`));
    if(sha256(bytes)!==manifest.sha256)throw new Error('Approved model hash mismatch');
    const model=validateModel(JSON.parse(bytes));
    this.current=model;this.active=manifest;
  }
  async status(extra={}) {
    await atomicJson(path.join(this.directory,'status.json'),{enabled:true,minRounds:this.minRounds,
      cooldownHours:this.cooldownMs/3600000,activeModel:this.active?.sha256||'existing-server-policy',
      pendingRun:this.state.pending?.id||null,updatedAt:new Date().toISOString(),...extra});
  }
  async persist(){await atomicJson(path.join(this.directory,'state.json'),this.state);}
  async finishPending() {
    const pending=this.state.pending;if(!pending)return;
    const result=await readJson(path.join(this.directory,'runs',pending.id,'result.json'));
    if(!result)return false;
    if(result.ok) {
      this.state.processed=[...new Set([...this.state.processed,...pending.files])];
      this.state.lastCompleted=Date.now();this.state.failures=0;
      const candidate=path.join(this.directory,'runs',pending.id,'training','candidate.json');
      if(await fs.access(candidate).then(()=>true,()=>false))this.state.lastCandidate=candidate;
    } else {this.state.failures++;this.state.retryAfter=Date.now()+30*60000;}
    this.state.lastResult=result;delete this.state.pending;
    await this.persist();await this.refreshModel();
    return true;
  }
  async tick() {
    if(this.checking)return;this.checking=true;
    try {
      await this.refreshModel();
      if(this.state.pending) {
        if(!await this.finishPending()) {
          // On restart, adopt the result of a still-running worker. Never kill a
          // PID from disk or launch a second worker based on a stale PID alone.
          const p=this.state.pending;
          let alive=false;try{if(p.pid){process.kill(p.pid,0);alive=true;}}catch{}
          if(!alive&&!this.child) {
            const lockPath=path.join(this.directory,'worker.lock'),lock=await readJson(lockPath);
            if(lock?.pid===p.pid&&path.resolve(lock.runDir)===path.resolve(this.directory,'runs',p.id))
              await fs.unlink(lockPath).catch(()=>{});
            this.state.failures++;this.state.retryAfter=Date.now()+30*60000;
            delete this.state.pending;await this.persist();
            await this.status({phase:'interrupted',message:'Previous worker stopped; retry delayed'});
          }else await this.status({phase:'training-or-evaluating'});
          return;
        }
      }
      const rounds=path.join(this.directory,'rounds');await fs.mkdir(rounds,{recursive:true});
      const files=(await fs.readdir(rounds)).filter(f=>/^[0-9a-f-]+\.json\.gz$/.test(f)).sort();
      const processed=new Set(this.state.processed);const fresh=files.filter(f=>!processed.has(f));
      this.state.processed=this.state.processed.filter(f=>files.includes(f));
      const waiting=this.state.failures>=3?'paused-after-errors':Date.now()<(this.state.retryAfter||0)?'retry-delayed':
        Date.now()-this.state.lastCompleted<this.cooldownMs?'cooldown':fresh.length<this.minRounds?'collecting':null;
      if(waiting){await this.status({phase:waiting,newCompletedRounds:fresh.length,lastResult:this.state.lastResult||null});return;}
      const id=crypto.randomUUID(),runDir=path.join(this.directory,'runs',id),selected=fresh.slice(0,this.minRounds);
      await fs.mkdir(path.join(runDir,'rounds'),{recursive:true});
      // Snapshot files before retention can prune the live data directory.
      const snapshots=[];
      const replay=files.filter(f=>processed.has(f)).slice(-60);
      for(const file of [...selected,...replay]){const to=path.join(runDir,'rounds',file);await fs.copyFile(path.join(rounds,file),to);snapshots.push(to);}
      await atomicJson(path.join(runDir,'live-manifest.json'),snapshots);
      const activePath=path.join(this.directory,'active.json');
      const activeBytes=await fs.readFile(activePath).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
      const incumbent=this.active?path.join(this.directory,'models',`${this.active.sha256}.json`):this.fallbackPath;
      const shadow=this.state.lastCandidate&&await fs.access(this.state.lastCandidate).then(()=>true,()=>false)?this.state.lastCandidate:null;
      const config={root:this.root,directory:this.directory,runDir,python:this.python,initModel:shadow||incumbent||this.initModel,
        incumbent,expectedActiveDigest:activeBytes?sha256(activeBytes):null,evalSeeds:this.evalSeeds,
        masterOptions:{determinizations:64,maxCandidates:8,timeBudgetMs:Number(process.env.MASTER_PIMC_MS||1300),rolloutLevel:'master'}};
      await atomicJson(path.join(runDir,'job.json'),config);
      this.state.pending={id,files:selected,startedAt:Date.now()};await this.persist();
      const log=await fs.open(path.join(runDir,'worker.log'),'a');
      let child;
      try {
        child=spawn(process.execPath,[path.join(this.root,'bench/learning/automatic-worker.mjs'),path.join(runDir,'job.json')],
          {cwd:this.root,windowsHide:true,stdio:['ignore',log.fd,log.fd]});
        this.child=child;
        child.once('error',error=>{
          atomicJson(path.join(runDir,'result.json'),{ok:false,error:error.message}).catch(this.onError);
        });
        child.once('close',()=>{this.child=null;this.tick().catch(this.onError);});
      }
      finally {await log.close();}
      this.state.pending.pid=child.pid;await this.persist();
      try{os.setPriority(child.pid,os.constants.priority.PRIORITY_BELOW_NORMAL);}catch{}
      await this.status({phase:'training-or-evaluating',newCompletedRounds:fresh.length});
    }catch(error){this.onError(error);await this.status({phase:'error',message:error.message}).catch(this.onError);}
    finally{this.checking=false;}
  }
  async close(){clearInterval(this.timer);await this.recorder.flush();}
}
