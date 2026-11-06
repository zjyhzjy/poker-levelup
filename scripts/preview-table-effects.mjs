// Make an offline review artifact from the exact production renderer and sounds.
// This page doesn't connect to a game, record rounds or change an active model.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

if(!process.argv[2])throw new Error('Usage: node scripts/preview-table-effects.mjs <output.html>');
const root=fileURLToPath(new URL('../',import.meta.url));
const read=name=>fs.readFile(path.join(root,'public',name),'utf8');
const css=await read('table-effects.css');
let renderer=(await read('table-effects.js')).replace(/^export /gm,'');
for(const name of ['tractor-effect.svg','bomb-effect.svg']){
  const data=Buffer.from(await read(name)).toString('base64');
  renderer=renderer.replaceAll(`/${name}`,`data:image/svg+xml;base64,${data}`);
}
const audio=(await read('audio.js')).replace(/^export /gm,'').replaceAll('localStorage','previewStore');
const examples=[
  {kind:'tractor',title:'拖拉机！',subtitle:'四轮驱动 · 全速碾压',tag:'3 连发',label:'🚜 拖拉机'},
  {kind:'tractor',title:'三条拖拉机',subtitle:'9 张连击 · 重装出击',tag:'3 连发',label:'🔥 三条拖拉机'},
  {kind:'bomb',title:'毙了！',subtitle:'主牌轰炸 · 全场震撼',label:'💣 主牌爆破'},
  {kind:'overkill',title:'反杀！',subtitle:'后手压制 · 火力全开',label:'⚡ 反杀'},
  {kind:'throw',title:'甩牌成功',subtitle:'这一手，拿捏了！',tag:'8 张齐出',label:'🃏 甩牌成功'},
  {kind:'throw-fail',title:'甩牌失败',subtitle:'绷不住了！退牌重来',tag:'−10 分',label:'💥 甩牌失败'},
  {kind:'triple',title:'三条压阵',subtitle:'三倍气场 · 强势出击',label:'♠ 三条'},
  {kind:'harvest',title:'大丰收！',subtitle:'这波血赚',tag:'+60 分',label:'✨ 大丰收'},
  {kind:'victory',title:'本局胜利！',subtitle:'这一局，打得漂亮',tag:'升 3 级',label:'🏆 胜利'},
  {kind:'defeat',title:'下局再战',subtitle:'调整一下，下把拿捏',label:'🌙 下局再战'}
];
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>牌桌高能时刻 · 特效预览</title><style>
*{box-sizing:border-box}body{margin:0;background:#071b19;color:#f7e9c9;font-family:system-ui,'Microsoft YaHei',sans-serif}
main{max-width:960px;margin:auto;padding:28px 18px 40px}header{margin-bottom:18px}.eyebrow{font-size:11px;letter-spacing:.3em;color:#cfab64}
h1{margin:7px 0;font-size:clamp(26px,5vw,42px)}header p{color:#96b6ab;font-size:14px;line-height:1.6;margin:0}
.toolbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:18px 0}button,select{font:inherit;border:1px solid #6b6543;border-radius:9px;background:#163a32;color:#ffedb5;padding:9px 13px;cursor:pointer}
button:hover{background:#285648}button:focus-visible,select:focus-visible{outline:3px solid #f7d77c;outline-offset:2px}.toolbar label{display:flex;align-items:center;gap:8px;font-size:13px}
.table-felt{height:550px;position:relative;border:9px solid #55452f;border-radius:90px;background:radial-gradient(ellipse at 50% 42%,#367863,#144338 72%);box-shadow:inset 0 0 70px #071b1c90,0 15px 38px #0005;overflow:hidden;isolation:isolate}
.table-felt:before{content:'';position:absolute;inset:24px;border:1px solid #d5be752e;border-radius:70px}.table-label{position:absolute;top:17px;width:100%;text-align:center;font-size:10px;letter-spacing:.3em;color:#c0d8bd99}
.demo-avatar{position:absolute;top:40px;left:50%;translate:-50% 0;border:2px solid #dabb6b;border-radius:50%;background:#082f2b;width:52px;height:52px;text-align:center;font-size:30px;line-height:48px}
.demo-avatar.left{left:12%;top:43%}.demo-avatar.right{left:88%;top:43%}.demo-cards{display:flex;position:absolute;left:50%;top:35%;translate:-50% 0;gap:6px}
.demo-card{display:block;width:48px;height:70px;background:#fff4d9;border:2px solid #d9c286;border-radius:6px;padding:5px;color:#832b32;font-size:19px;box-shadow:0 4px 12px #0005}.demo-card:nth-child(2){rotate:6deg;margin-left:-20px}
.hand{position:absolute;bottom:59px;left:50%;translate:-50% 0;display:flex;justify-content:center;width:80%;gap:3px}.hand .demo-card{margin:0;rotate:0;width:38px;height:60px;font-size:15px}
.play-row{position:absolute;bottom:14px;width:100%;text-align:center}.play-row button{background:#e8c56e;color:#17342a;font-weight:800;min-width:120px}.play-row span{display:block;font-size:11px;color:#b5cfbc;margin-top:5px}
.choices{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:9px;margin-top:20px}.choices button{font-size:13px;padding:13px 5px}
.note{font-size:12px;color:#8faea2;line-height:1.7;margin-top:17px}@media(max-width:580px){main{padding:20px 10px}.table-felt{height:480px;border-radius:50px;border-width:6px}.table-felt:before{border-radius:40px;inset:15px}.choices{grid-template-columns:repeat(2,minmax(0,1fr))}.demo-avatar.left{left:10%}.demo-avatar.right{left:90%}}
${css}</style>
<main><header><div class="eyebrow">POKER LEVELUP / SHOWTIME</div><h1>牌桌高能时刻</h1><p>点播拖拉机、爆破、甩牌和结算效果。底部「出牌」按钮可在动画中点击。</p></header>
<div class="toolbar"><label>特效强度 <select id="mode"><option value="full">炸裂</option><option value="lite">轻量</option><option value="off">关闭</option></select></label><button id="sound">🔇 音效：关</button><button id="stop">停止动画</button></div>
<div class="table-felt" id="demo-table"><div class="table-label">五人找朋友 · 特效预览</div><div class="demo-avatar">👑</div><div class="demo-avatar left">🦊</div><div class="demo-avatar right">🤖</div>
<div class="demo-cards"><b class="demo-card">A<br>♠</b><b class="demo-card">A<br>♠</b></div>
<div class="hand">${['K','K','Q','Q','J','10'].map(r=>`<b class="demo-card">${r}<br>♥</b>`).join('')}</div>
<div class="play-row"><button id="play">出牌</button><span id="clicks">动画不会拦截操作</span></div></div>
<div class="choices">${examples.map((e,i)=>`<button data-effect="${i}">${e.label}</button>`).join('')}</div>
<p class="note">爆破对应升级规则中的主牌毙牌和反杀。系统开启「减少动态效果」时自动使用轻量提示。音效默认关闭，点击上方开关试听。</p></main>
<script type="module">
const previewStore={getItem:()=>null,setItem:()=>{}};
${audio}
${renderer}
const examples=${JSON.stringify(examples)};
const fx=createTableEffects({document,window,sound:sfx,root:()=>document.getElementById('demo-table')});
const mode=document.getElementById('mode');mode.value=fx.mode;
mode.addEventListener('change',()=>fx.setMode(mode.value));
document.querySelectorAll('[data-effect]').forEach(button=>button.addEventListener('click',()=>{fx.clear();fx.play({...examples[Number(button.dataset.effect)],key:'preview-'+Date.now()});}));
document.getElementById('sound').addEventListener('click',event=>{unlock();event.target.textContent=toggleVoice()?'🔊 音效：开':'🔇 音效：关';});
document.getElementById('stop').addEventListener('click',()=>fx.clear());
let count=0;document.getElementById('play').addEventListener('click',()=>document.getElementById('clicks').textContent='出牌点击已响应 '+(++count)+' 次');
</script></html>`;
const output=path.resolve(process.argv[2]);await fs.mkdir(path.dirname(output),{recursive:true});
await fs.writeFile(output,html);console.log(output);
