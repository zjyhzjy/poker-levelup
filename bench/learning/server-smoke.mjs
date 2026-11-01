// Starts an isolated local server, verifies checkpoint loading and both room
// modes, then stops only the child it created. Does not touch the public server.
import net from 'node:net';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
const model=process.argv[2];
if(!model)throw new Error('Usage: node bench/learning/server-smoke.mjs <checkpoint.json>');
const root=fileURLToPath(new URL('../../',import.meta.url));
const reserve=net.createServer();
reserve.listen(0,'127.0.0.1');await once(reserve,'listening');
const port=reserve.address().port;
await new Promise(resolve=>reserve.close(resolve));
const child=spawn(process.execPath,['server.js'],{cwd:root,windowsHide:true,
  env:{...process.env,PORT:String(port),LEARNED_AI_MODEL:path.resolve(model)},stdio:['ignore','pipe','pipe']});
let output='';
child.stdout.on('data',chunk=>{output+=chunk;});
child.stderr.on('data',chunk=>{output+=chunk;});
try {
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{clearInterval(check);reject(new Error(`Startup timeout: ${output}`));},10000);
    const check=setInterval(()=>{
      if(output.includes('running at')){clearInterval(check);clearTimeout(timer);resolve();}
      else if(child.exitCode!==null){clearInterval(check);clearTimeout(timer);reject(new Error(output));}
    },50);
    child.once('error',error=>{clearInterval(check);clearTimeout(timer);reject(error);});
  });
  if(!output.includes('Experimental learned AI enabled'))throw new Error('Model was not enabled');
  const base=`http://127.0.0.1:${port}`;
  if((await fetch(base,{signal:AbortSignal.timeout(5000)})).status!==200)throw new Error('Homepage failed');
  for(const seats of [5,6]) {
    const response=await fetch(`${base}/api/rooms?seatCount=${seats}`,{method:'POST',signal:AbortSignal.timeout(5000)});
    const {code}=await response.json();
    await new Promise((resolve,reject)=>{
      const ws=new WebSocket(base.replace(/^http/,'ws'));
      const finish=error=>{clearTimeout(timer);ws.close();error?reject(error):resolve();};
      const timer=setTimeout(()=>finish(new Error('WebSocket timeout')),5000);
      ws.onerror=()=>finish(new Error('WebSocket failed'));
      ws.onmessage=({data})=>{
        const message=JSON.parse(data);
        if(message.type==='hello')ws.send(JSON.stringify({type:'joinRoom',payload:{code,nickname:'AI smoke check'}}));
        if(message.type==='error')finish(new Error(message.payload.message));
        if(message.type==='state')finish(message.payload.seatCount===seats?null:new Error('Wrong room mode'));
      };
    });
  }
  console.log('PASS: experimental model loaded; homepage and 5/6-player HTTP + WebSocket paths work');
} finally {
  child.kill();
  if(child.exitCode===null)await once(child,'exit');
}
