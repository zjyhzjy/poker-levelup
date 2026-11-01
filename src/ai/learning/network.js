import { SCHEMA, OBSERVATION_SIZE, ACTION_SIZE, decisionInput, voidSuits, FACES } from './observation.js';
import { playSuit } from '../../game.js';

const dot = (a,b) => {let s=0; for(let i=0;i<a.length;i++) s+=a[i]*b[i]; return s;};
const dense = (x,w,b) => w.map((row,i)=>dot(row,x)+b[i]);
const tanh = xs => xs.map(Math.tanh);
const softmax = xs => {const m=Math.max(...xs), e=xs.map(x=>Math.exp(x-m)), s=e.reduce((a,b)=>a+b,0);return e.map(v=>v/s);};

export function validateModel(model) {
  if (model.schema !== SCHEMA || model.observationSize !== OBSERVATION_SIZE || model.actionSize !== ACTION_SIZE
    || ![5,6].every(n=>model.seatCounts?.includes(n))) throw new Error('Incompatible learned AI checkpoint');
  const h=model.hiddenSize, q=model.actionHiddenSize;
  if (!Number.isInteger(h)||h<1||h>512||!Number.isInteger(q)||q<1||q>512) throw new Error('Invalid model width');
  for (const [name,rows,cols] of [['encoderW',h,OBSERVATION_SIZE],['qW',q,h+ACTION_SIZE],['beliefW',378,h],['behaviorW',48,h],['valueW',1,q]]) {
    const a=model[name];
    if (!Array.isArray(a)||a.length!==rows||a.some(row=>!Array.isArray(row)||row.length!==cols||row.some(v=>!Number.isFinite(v)))) throw new Error(`Invalid ${name}`);
  }
  for (const [name,size] of [['encoderB',h],['qB',q],['beliefB',378],['behaviorB',48],['valueB',1]]) {
    if (!Array.isArray(model[name])||model[name].length!==size||model[name].some(v=>!Number.isFinite(v))) throw new Error(`Invalid ${name}`);
  }
  return model;
}

export function scoreActions(model, observation, actions) {
  const latent=tanh(dense(observation,model.encoderW,model.encoderB));
  return actions.map(a=>dense(tanh(dense([...latent,...a],model.qW,model.qB)),model.valueW,model.valueB)[0]);
}

export function predictAuxiliary(model, observation) {
  const latent=tanh(dense(observation,model.encoderW,model.encoderB));
  const belief=dense(latent,model.beliefW,model.beliefB).map(x=>3/(1+Math.exp(-x)));
  const logits=dense(latent,model.behaviorW,model.behaviorB);
  return {expectedCounts:Array.from({length:7},(_,i)=>belief.slice(i*54,(i+1)*54)),
    nextActionProbabilities:Array.from({length:6},(_,i)=>softmax(logits.slice(i*8,(i+1)*8)))};
}

export function chooseLearnedPlay(room, viewer, model) {
  const input=decisionInput(room,viewer);
  const values=scoreActions(model,input.observation,input.features);
  if (values.some(v=>!Number.isFinite(v))) throw new Error('Non-finite learned action value');
  const index=values.indexOf(Math.max(...values));
  return input.actions[index];
}

// Diagnostic estimates only, not a joint card-deal sampler. Hard impossibilities
// are zeroed, but these marginal estimates need not sum to exact hand capacities.
export function explainDecision(room, viewer, model) {
  const input=decisionInput(room,viewer), prediction=predictAuxiliary(model,input.observation), voids=voidSuits(input.view);
  for(let r=0;r<6;r++) {
    const seat=(viewer+r)%room.seatCount;
    if(r===0||r>=room.seatCount) {
      prediction.expectedCounts[r].fill(0);
      prediction.nextActionProbabilities[r]=null;
    }
    else prediction.expectedCounts[r]=prediction.expectedCounts[r].map((v,i)=>voids[seat].has(playSuit(FACES[i],input.view))?0:v);
  }
  if(viewer===room.dealerSeat) prediction.expectedCounts[6].fill(0);
  return {...prediction, values:scoreActions(model,input.observation,input.features),
    actions:input.actions.map(a=>a.map(c=>({rank:c.rank,suit:c.suit}))), seatOrder:'relative-to-viewer',
    note:'Experimental marginal estimates; not calibrated probabilities or exact joint hand assignments.'};
}
