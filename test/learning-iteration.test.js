import test from 'node:test';
import assert from 'node:assert/strict';
import {selectDevelopment} from '../bench/learning/iterate.mjs';
const row=(name,five,six)=>({label:name,report:{modes:{5:{meanNetLevelDelta:five},6:{meanNetLevelDelta:six}}}});

test('development selection retains the reference if either mode regresses',()=>{
  const reference=row('old',-.1,-.05),unbalanced=row('unbalanced',.5,-.06),better=row('balanced',-.04,0);
  assert.equal(selectDevelopment([reference,unbalanced],reference),reference);
  assert.equal(selectDevelopment([reference,unbalanced,better],reference),better);
});

test('development selection retains ties and rejects missing or invalid controls',()=>{
  const reference=row('old',0,0),tie=row('tie',0,1);
  assert.equal(selectDevelopment([reference,tie],reference),reference);
  assert.throws(()=>selectDevelopment([tie],reference),/Reference/);
  assert.throws(()=>selectDevelopment([reference,row('bad',NaN,1)],reference),/Invalid/);
});
