import {createDeck,shuffle} from '../cards.js';
import {playSuit} from '../game.js';
import {recordTripleLockDecision as lockFive} from '../rules/findFriend5.js';
import {recordTripleLockDecision as lockSix} from '../rules/fixedTeam6.js';
import {recordTripleLockDecision as lockFour} from '../rules/classic4.js';

export function publicVoids(room,viewer) {
  const voids=room.seats.map(()=>new Set());
  for(const plays of [...room.finishedTricks.map(t=>t.plays),room.currentTrick]) {
    if(!plays.length)continue;
    const suit=playSuit(plays[0].cards[0],room),length=plays[0].cards.length;
    for(const p of plays.slice(1))if(p.seat!==viewer&&p.cards.filter(c=>playSuit(c,room)===suit).length<length)voids[p.seat].add(suit);
  }
  return voids;
}

// Capacity-constrained bipartite assignment. Hall's subset inequalities let us
// reject choices that would strand a later card. At most six destinations =>
// only 64 subsets. Randomized choices give a valid proposal, not uniform or
// calibrated Bayesian samples. Impossible evidence returns null, never a deal
// that silently ignores a known void or exposed card.
export function assignConstrainedCards(pool,targets,allowed,rng=Math.random) {
  const n=targets.length,limit=1<<n;
  if(n>6||targets.some(t=>!Number.isInteger(t.need)||t.need<0))throw new Error('Invalid hidden-card destinations');
  if(targets.reduce((s,t)=>s+t.need,0)!==pool.length)return null;
  const slots=targets.map(t=>({...t,cards:[]}));
  const cards=shuffle(pool,rng).map(card=>({card,mask:allowed(card,targets)}));
  if(cards.some(c=>!Number.isInteger(c.mask)||c.mask<=0||c.mask>=limit))return null;
  const capacity=Array(limit).fill(0),demand=Array(limit).fill(0);
  for(let subset=1;subset<limit;subset++) {
    capacity[subset]=targets.reduce((s,t,i)=>s+((subset&(1<<i))?t.need:0),0);
    demand[subset]=cards.reduce((s,c)=>s+Number((c.mask&subset)===c.mask),0);
    if(demand[subset]>capacity[subset])return null;
  }
  const bits=x=>{let count=0;for(;x;x&=x-1)count++;return count;};
  cards.sort((a,b)=>bits(a.mask)-bits(b.mask));
  for(const {card,mask} of cards) {
    for(let subset=1;subset<limit;subset++)if((mask&subset)===mask)demand[subset]--;
    const choices=[];
    for(let i=0;i<n;i++) {
      const bit=1<<i,remaining=slots[i].need-slots[i].cards.length;
      if(!(mask&bit)||!remaining)continue;
      let feasible=true;
      for(let subset=1;subset<limit;subset++)if((subset&bit)&&capacity[subset]-1<demand[subset]){feasible=false;break;}
      if(feasible)choices.push({i,remaining});
    }
    if(!choices.length)return null;
    let draw=rng()*choices.reduce((s,c)=>s+c.remaining,0),chosen=choices.at(-1).i;
    for(const c of choices){draw-=c.remaining;if(draw<=0){chosen=c.i;break;}}
    slots[chosen].cards.push(card);
    for(let subset=1;subset<limit;subset++)if(subset&(1<<chosen))capacity[subset]--;
  }
  return slots;
}

const face=c=>`${c.suit}:${c.rank}`;
const faceCounts=cards=>{const counts=new Map();for(const c of cards)counts.set(face(c),(counts.get(face(c))||0)+1);return counts;};

function publicOwners(room,targets,pool,rng) {
  const bounds=new Map(),played=room.seats.map(()=>[]);
  for(const plays of [...room.finishedTricks.map(t=>t.plays),room.currentTrick])for(const p of plays)played[p.seat].push(...p.cards);
  const playedCounts=played.map(faceCounts);
  const mark=(cards,indices,subtractSeat=null)=>{
    const mask=targets.reduce((s,t,i)=>s|(indices.includes(t.index)?1<<i:0),0);
    if(!mask)return; // The viewer already knows its own hand and buried cards.
    for(const [f,count] of faceCounts(cards)) {
      const minimum=Math.max(0,count-(subtractSeat==null?0:playedCounts[subtractSeat].get(f)||0));
      const key=`${mask}/${f}`,old=bounds.get(key);
      if(minimum&&(!old||minimum>old.minimum))bounds.set(key,{mask,face:f,minimum});
    }
  };
  // A dealer can bury an exposed bid card. A revealed original-kitty card also
  // belongs to either the dealer's remaining hand or the newly buried kitty.
  mark(room.revealedKitty||[],[room.dealerSeat,-1],room.dealerSeat);
  const bids=[...Object.values(room.seatBids||{}),room.currentBid].filter(Boolean);
  for(const bid of bids) {
    // seatBids' display objects omit seat; recover it from their dictionary.
    let seat=bid.seat;
    if(seat==null)seat=Object.entries(room.seatBids||{}).find(([,b])=>b===bid)?.[0];
    if(seat==null)continue;seat=Number(seat);
    mark(bid.cards||[],seat===room.dealerSeat?[seat,-1]:[seat],seat);
  }
  if(room.throwResult?.failed) {
    const kept=faceCounts(room.throwResult.keepCards||[]),returned=[];
    for(const c of room.throwResult.allCards||[]) {
      const n=kept.get(face(c))||0;
      if(n)kept.set(face(c),n-1);else returned.push(c);
    }
    mark(returned,[room.throwResult.seat]);
  }
  // A public card face does not reveal which physical deck copy was played
  // later. Enforce conservative remaining FACE-count lower bounds, assigning
  // arbitrary hidden copy IDs only as interchangeable simulation labels.
  const owners=new Map(),byFace=new Map();
  for(const c of shuffle(pool,rng)){const f=face(c);if(!byFace.has(f))byFace.set(f,[]);byFace.get(f).push(c);}
  const bits=x=>{let count=0;for(;x;x&=x-1)count++;return count;};
  for(const bound of [...bounds.values()].sort((a,b)=>bits(a.mask)-bits(b.mask))) {
    const cards=byFace.get(bound.face)||[];
    const satisfied=cards.filter(c=>owners.has(c.id)&&(owners.get(c.id)&bound.mask)===owners.get(c.id)).length;
    const free=cards.filter(c=>!owners.has(c.id));
    const need=Math.max(0,bound.minimum-satisfied);
    if(free.length<need)return null;
    for(const c of free.slice(0,need))owners.set(c.id,bound.mask);
  }
  return owners;
}

// Locks depend on private historical hands, so copying the real opponents'
// lockedTriples would leak information into a sampled world. Reconstruct them
// from this hypothesis's current hands plus the public sequence of played cards.
function reconstructLocks(world,viewer) {
  const tricks=[...world.finishedTricks.map(t=>t.plays),world.currentTrick];
  const seats=world.seats.map(s=>({...s,hand:[...s.hand],lockedTriples:[]}));
  for(const plays of tricks)for(const p of plays)seats[p.seat].hand.push(...p.cards);
  const history={...world,seats,currentTrick:[]};
  const lock=world.mode==='fixedTeam6'?lockSix:world.mode==='classic4'?lockFour:lockFive;
  for(const plays of tricks) {
    history.currentTrick=[];
    for(const p of plays) {
      const seat=seats[p.seat];
      if(history.currentTrick.length)lock(history,seat,p.cards,history.currentTrick[0].cards);
      const ids=new Set(p.cards.map(c=>c.id));seat.hand=seat.hand.filter(c=>!ids.has(c.id));
      history.currentTrick.push(p);
    }
  }
  for(const seat of world.seats)if(seat.index!==viewer)seat.lockedTriples=seats[seat.index].lockedTriples;
}

export function determinizePublicWorld(room,viewer,world,rng=Math.random) {
  const known=new Set(room.seats[viewer].hand.map(c=>c.id));
  for(const plays of [...room.finishedTricks.map(t=>t.plays),room.currentTrick])for(const p of plays)for(const c of p.cards)known.add(c.id);
  if(viewer===room.dealerSeat)for(const c of room.hiddenKitty)known.add(c.id);
  const pool=createDeck(room.deckCopies).filter(c=>!known.has(c.id)),voids=publicVoids(room,viewer);
  const targets=room.seats.filter(s=>s.index!==viewer).map(s=>({index:s.index,need:s.hand.length}));
  if(viewer!==room.dealerSeat)targets.push({index:-1,need:room.hiddenKitty.length});
  const owners=publicOwners(room,targets,pool,rng);
  if(!owners)return null;
  const assigned=assignConstrainedCards(pool,targets,card=>targets.reduce((mask,t,i)=>{
    if(t.index>=0&&voids[t.index].has(playSuit(card,room)))return mask;
    if(owners.has(card.id)&&!(owners.get(card.id)&(1<<i)))return mask;
    return mask|(1<<i);
  },0),rng);
  if(!assigned)return null;
  for(const t of assigned)if(t.index===-1)world.hiddenKitty=t.cards;else world.seats[t.index].hand=t.cards;
  reconstructLocks(world,viewer);
  return world;
}
