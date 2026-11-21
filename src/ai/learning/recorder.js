import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {gzip} from 'node:zlib';
import {promisify} from 'node:util';
import {observeRoomPlays} from '../../game.js';
import {informationSet,encodeObservation,encodeAction,behaviorClass,SCHEMA} from './observation.js';
import {privilegedTargets,terminalReward} from './targets.js';

const compress=promisify(gzip);
export class RoundRecorder {
  constructor({directory,onSaved=()=>{},onError=console.error,maxRounds=1000,retentionDays=30,maxBytes=512*1024*1024}) {
    Object.assign(this,{directory,onSaved,onError,maxRounds,retentionDays,maxBytes});
    this.states=new WeakMap();this.pending=new Set();this.dropped=0;
  }
  attach(room) {
    if(![5,6].includes(room.seatCount))return;
    observeRoomPlays(room,{
      before:(r,s,ids,forced)=>{
        try{return this.before(r,s,ids,forced);}
        catch(error){this.states.set(r,{round:r.round,invalid:true});this.onError(error);return null;}
      },
      after:(r,token)=>{
        try{this.after(r,token);}
        catch(error){this.states.set(r,{round:r.round,invalid:true});this.onError(error);}
      }
    });
  }
  before(room,seat,ids,forced) {
    let state=this.states.get(room);
    if(!state||state.round!==room.round) {
      state={round:room.round,invalid:room.finishedTricks.length>0||room.currentTrick.length>0,rows:[],human:0};
      this.states.set(room,state);
    }
    if(state.invalid||state.saved)return null;
    const requested=ids.map(id=>seat.hand.find(c=>c.id===id));
    if(requested.some(c=>!c)||new Set(ids).size!==ids.length||!ids.length)return null;
    const view=informationSet(room,seat.index);
    const source=forced?'forced':seat.isAi?'ai':seat.trustee?'trustee':'human';
    return {state,viewer:seat.index,source,category:behaviorClass(view,requested,view.currentTrick[0]?.cards||[]),
      observation:encodeObservation(view),action:encodeAction(view,requested),...privilegedTargets(room,seat.index)};
  }
  after(room,token) {
    if(!token||token.state!==this.states.get(room)||token.state.invalid||token.state.saved)return;
    const state=token.state;
    const {state:_,...row}=token;
    state.rows.push(row);if(row.source==='human')state.human++;
    // All real/AI/forced actions counted; failed attempts never reach this hook.
    if(state.rows.length>200){state.invalid=true;state.rows=[];return;}
    if(room.phase!=='roundOver')return;
    state.saved=true;
    if(!state.human){state.rows=[];return;}
    const samples=state.rows.map((r,i)=>{
      const behavior=Array(6).fill(-1);
      for(let j=i+1;j<state.rows.length;j++) {
        const next=state.rows[j],relative=(next.viewer-r.viewer+room.seatCount)%room.seatCount;
        if(relative&&behavior[relative]===-1)behavior[relative]=next.category;
      }
      return {observation:r.observation,action:r.action,belief:r.belief,beliefMask:r.beliefMask,
        behavior,reward:terminalReward(room,r.viewer),seatCount:room.seatCount,source:r.source};
    });
    state.rows=[];
    const record={schema:SCHEMA,recordType:'completed-live-round-v1',seatCount:room.seatCount,
      humanActions:state.human,samples};
    // Bound in-flight compression/write work; never stall a live move on storage.
    if(this.pending.size>=8){this.dropped++;return;}
    const promise=this.save(record).catch(error=>this.onError(error)).finally(()=>this.pending.delete(promise));
    this.pending.add(promise);
  }
  async save(record) {
    await fs.mkdir(this.directory,{recursive:true});
    const file=path.join(this.directory,`${crypto.randomUUID()}.json.gz`),temp=file+'.tmp';
    try {
      await fs.writeFile(temp,await compress(JSON.stringify(record)),{flag:'wx',mode:0o600});
      await fs.rename(temp,file);
      await this.prune();
      await this.onSaved(file);
    } finally {await fs.unlink(temp).catch(()=>{});}
  }
  async prune() {
    const files=[];
    for(const name of await fs.readdir(this.directory)) {
      if(!/^[0-9a-f-]+\.json\.gz$/.test(name))continue;
      const file=path.join(this.directory,name),stat=await fs.stat(file);
      files.push({file,size:stat.size,mtime:stat.mtimeMs});
    }
    files.sort((a,b)=>b.mtime-a.mtime);let bytes=0;
    for(let i=0;i<files.length;i++) {
      const f=files[i];bytes+=f.size;
      if(i>=this.maxRounds||bytes>this.maxBytes||Date.now()-f.mtime>this.retentionDays*86400000)await fs.unlink(f.file).catch(()=>{});
    }
  }
  async flush(){await Promise.all([...this.pending]);}
}
