import {playEpisode} from './environment.mjs';

export const MASTER_OPTIONS={determinizations:64,maxCandidates:8,timeBudgetMs:1300,rolloutLevel:'master'};
export function promotionGate(reports) {
  const reasons=[];
  for(const name of ['incumbent','hard'])for(const n of [5,6]) {
    const m=reports[name]?.modes?.[n];
    if(!m||m.independentDeals<24||!Number.isFinite(m.meanNetLevelDelta)||!Number.isFinite(m.standardError)
      ||m.standardError<0||m.meanNetLevelDelta-2.58*m.standardError<=0)reasons.push(`${name}/${n}: insufficient positive evidence`);
  }
  return {accepted:reasons.length===0,reasons,criterion:'At least 24 unseen deals per mode; mean - 2.58*deal-clustered SE > 0 against both incumbent and hard heuristic. Approximate statistical gate, not a guarantee.'};
}

export function compareIncumbent({candidate,incumbent=null,seeds=24,seed,masterOptions=MASTER_OPTIONS,onProgress=()=>{}}) {
  const used=new Set([...(candidate.metadata?.trainingSeeds||[]),...(incumbent?.metadata?.trainingSeeds||[])]),modes={};
  if(!Number.isInteger(seeds)||seeds<2||!Number.isInteger(seed)||seed<0||seed+(seeds-1)*7919>0xffffffff)throw new Error('Invalid evaluation seeds');
  for(const n of [5,6]) {
    const deltas=[];
    for(let i=0;i<seeds;i++) {
      const dealSeed=seed+i*7919;
      if(used.has(dealSeed))throw new Error('Evaluation overlaps training');
      const rotated=[];
      for(let seat=0;seat<n;seat++) {
        const policies=Array(n).fill('hard');policies[seat]=incumbent?'learned':'master';
        const old=playEpisode({seed:dealSeed,seatCount:n,policies,model:incumbent,masterOptions});
        policies[seat]='learned';
        const next=playEpisode({seed:dealSeed,seatCount:n,policies,model:candidate});
        rotated.push((next.rewards[seat]-old.rewards[seat])*3);
      }
      deltas.push(rotated.reduce((a,b)=>a+b,0)/n);
      onProgress({mode:n,completedDeals:i+1,totalDeals:seeds});
    }
    const mean=deltas.reduce((a,b)=>a+b,0)/seeds;
    const se=Math.sqrt(deltas.reduce((s,x)=>s+(x-mean)**2,0)/(seeds-1)/seeds);
    modes[n]={independentDeals:seeds,meanNetLevelDelta:mean,standardError:se};
  }
  return {incumbent:incumbent?'learned':'master-PIMC',masterOptions:incumbent?null:masterOptions,seed,modes};
}
