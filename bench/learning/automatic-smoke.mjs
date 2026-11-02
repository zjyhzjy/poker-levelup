// Synthetic human-marked games exercise the real recorder/worker chain in a
// separate directory. Two eval seeds deliberately fail the >=24-seed gate.
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {prepareRoom} from './environment.mjs';
import {RoundRecorder} from '../../src/ai/learning/recorder.js';
import {chooseAiPlay,playCards} from '../../src/game.js';
import {informationSet} from '../../src/ai/learning/observation.js';
import {atomicJson} from '../../src/ai/learning/automatic.js';
const root=fileURLToPath(new URL('../../',import.meta.url));
const [python,initModel,out]=process.argv.slice(2);
if(!python||!initModel||!out)throw new Error('Usage: automatic-smoke.mjs <python> <model> <new-output-directory>');
const directory=path.resolve(out),runDir=path.join(directory,'runs','smoke');
await fs.mkdir(directory,{recursive:false});await fs.mkdir(path.join(runDir,'rounds'),{recursive:true});
const errors=[],recorder=new RoundRecorder({directory:path.join(runDir,'rounds'),onError:e=>errors.push(e)});
for(const n of [5,6]) {
  const room=prepareRoom(9876,n);room.seats[room.turnSeat].isAi=false;recorder.attach(room);
  for(let step=0;room.phase==='playing'&&step<500;step++) {
    room.trickPauseUntil=0;const view=informationSet(room,room.turnSeat),seat=view.seats[view.viewer];
    const cards=chooseAiPlay(view,seat,view.currentTrick[0]?.cards||null);
    playCards(room,room.seats[room.turnSeat].playerId,cards.map(c=>c.id));
  }
  if(room.phase!=='roundOver')throw new Error('Smoke game stalled');
}
await recorder.flush();if(errors.length)throw errors[0];
const files=(await fs.readdir(path.join(runDir,'rounds'))).map(f=>path.join(runDir,'rounds',f));
if(files.length!==2)throw new Error('Expected exactly two completed recordings');
await atomicJson(path.join(runDir,'live-manifest.json'),files);
await atomicJson(path.join(runDir,'job.json'),{root,directory,runDir,python,initModel:path.resolve(initModel),
  incumbent:null,expectedActiveDigest:null,evalSeeds:2});
await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[path.join(root,'bench/learning/automatic-worker.mjs'),path.join(runDir,'job.json')],
    {cwd:root,windowsHide:true,stdio:'inherit'});
  child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(`Worker exited ${code}`)));
});
const result=JSON.parse(await fs.readFile(path.join(runDir,'result.json')));
if(!result.ok||result.promoted)throw new Error('Unsafe smoke promotion');
try{await fs.access(path.join(directory,'active.json'));throw new Error('Smoke must not install a champion');}
catch(error){if(error.code!=='ENOENT')throw error;}
const trained=JSON.parse(await fs.readFile(path.join(runDir,'training','candidate.json')));
if(trained.metadata.liveRounds!==2||trained.metadata.liveExamplesThisIteration<1)throw new Error('Live data was not used');
console.log('PASS: complete anonymous rounds -> mixed training -> evaluation -> reject -> incumbent unchanged');
