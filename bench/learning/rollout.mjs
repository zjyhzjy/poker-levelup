import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';
import {playEpisode,mulberry32} from './environment.mjs';
import {validateModel} from '../../src/ai/learning/network.js';

export function generate({games=20,seed=1,model=null,previous=null,epsilon=.15,sampleRate=.2,onSamples=()=>{}}) {
  const rng=mulberry32(seed), stats={games:0,modes:{5:0,6:0},samples:0,moves:0};
  for(let i=0;i<games;i++) {
    const seatCount=i%2?6:5;
    // Mixed opponents and historical snapshots reduce single-opponent overfitting.
    const active=(previous&&i%4===0)?previous:model;
    const policies=Array.from({length:seatCount},()=>{
      const r=rng();
      return active&&r<.65?'learned':r<.82?'hard':r<.95?'easy':'random';
    });
    const episode=playEpisode({seed:seed+i*7919,seatCount,policies,model:active,epsilon,sampleRate,collect:true});
    onSamples(episode.samples);stats.games++;stats.modes[seatCount]++;stats.samples+=episode.samples.length;stats.moves+=episode.moves;
  }
  return stats;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const {values:v}=parseArgs({options:{games:{type:'string',default:'20'},seed:{type:'string',default:'1'},
    model:{type:'string'},previous:{type:'string'},out:{type:'string'},epsilon:{type:'string',default:'.15'},'sample-rate':{type:'string',default:'.2'}}});
  if(!v.out) throw new Error('--out is required');
  const games=Number(v.games),seed=Number(v.seed),epsilon=Number(v.epsilon),sampleRate=Number(v['sample-rate']);
  if(!Number.isInteger(games)||games<2||games%2||!Number.isSafeInteger(seed)||seed<0||seed+(games-1)*7919>0xffffffff||!Number.isFinite(epsilon)||epsilon<0||epsilon>1||!Number.isFinite(sampleRate)||sampleRate<=0||sampleRate>1) throw new Error('Invalid rollout arguments; games must be positive and even, seeds uint32');
  const load=p=>p?validateModel(JSON.parse(fs.readFileSync(p,'utf8'))):null;
  fs.mkdirSync(path.dirname(v.out),{recursive:true});
  const fd=fs.openSync(v.out,'w');
  try {console.log(JSON.stringify(generate({games,seed,model:load(v.model),previous:load(v.previous),epsilon,sampleRate,
    onSamples:samples=>{for(const sample of samples) fs.writeSync(fd,JSON.stringify(sample)+'\n');}})));}
  finally {fs.closeSync(fd);}
}
