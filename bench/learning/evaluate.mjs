import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';
import {playEpisode} from './environment.mjs';
import {validateModel} from '../../src/ai/learning/network.js';

export function evaluate({model,seeds=20,seed=1000000001,opponent='hard',candidatePolicy='learned'}) {
  if(!['hard','easy','random'].includes(opponent)) throw new Error('Unsupported evaluation opponent');
  if(!['learned','hard','easy','random'].includes(candidatePolicy)) throw new Error('Unsupported candidate policy');
  if(!Number.isSafeInteger(seed)||seed<0||seed+(seeds-1)*7919>0xffffffff) throw new Error('Invalid evaluation seed');
  if(!Number.isInteger(seeds)||seeds<2) throw new Error('Need at least 2 independent evaluation seeds');
  const trained=new Set(model.metadata?.trainingSeeds||[]), modes={};
  for(const seatCount of [5,6]) {
    const deltas=[];let positive=0,negative=0,tied=0,latencyMs=0,learnedMoves=0,games=0;
    for(let i=0;i<seeds;i++) {
      const dealSeed=seed+i*7919;
      if(trained.has(dealSeed)) throw new Error(`Evaluation seed ${dealSeed} was used in training`);
      const baseline=playEpisode({seed:dealSeed,seatCount,policies:Array(seatCount).fill(opponent)});
      games++;
      const rotations=[];
      for(let seat=0;seat<seatCount;seat++) {
        const policies=Array(seatCount).fill(opponent);policies[seat]=candidatePolicy;
        const episode=playEpisode({seed:dealSeed,seatCount,policies,model});games++;
        const delta=(episode.rewards[seat]-baseline.rewards[seat])*3;
        rotations.push(delta);
        if(delta>0)positive++;else if(delta<0)negative++;else tied++;
        latencyMs+=episode.latencyMs;learnedMoves+=episode.learnedMoves;
      }
      // Seat rotations on the same deal are dependent: estimate uncertainty by deal.
      deltas.push(rotations.reduce((a,b)=>a+b,0)/seatCount);
    }
    const mean=deltas.reduce((a,b)=>a+b,0)/deltas.length;
    const se=Math.sqrt(deltas.reduce((s,d)=>s+(d-mean)**2,0)/(deltas.length-1)/deltas.length);
    modes[seatCount]={independentDeals:seeds,games,meanNetLevelDelta:mean,standardError:se,
      approximate95Interval:[mean-1.96*se,mean+1.96*se],positive,negative,tied,
      meanNetworkScoringMs:learnedMoves?latencyMs/learnedMoves:0,
      verdict:mean-1.96*se>0?'positive-in-this-benchmark':mean+1.96*se<0?'negative-in-this-benchmark':'inconclusive'};
  }
  return {schema:'shengji-evaluation-v1',candidatePolicy,opponent,seed,modes,
    limitations:'Single-seat replacement against sanitized heuristic/random opponents; approximate deal-clustered intervals. Not a Nash exploitability, full-team, master-PIMC, or human-strength test.'};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const {values:v}=parseArgs({options:{model:{type:'string'},seeds:{type:'string',default:'20'},seed:{type:'string',default:'1000000001'},opponent:{type:'string',default:'hard'},out:{type:'string'}}});
  if(!v.model)throw new Error('--model is required');
  const report=evaluate({model:validateModel(JSON.parse(fs.readFileSync(v.model,'utf8'))),seeds:Number(v.seeds),seed:Number(v.seed),opponent:v.opponent});
  if(v.out){fs.mkdirSync(path.dirname(v.out),{recursive:true});fs.writeFileSync(v.out,JSON.stringify(report,null,2)+'\n');}
  console.log(JSON.stringify(report,null,2));
}
