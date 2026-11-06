// Public-state event detection is separate from presentation: a reconnect or
// repeated broadcast must never replay an old explosion or penalty.
const seq = room => room?.lastTrickWin?.seq || 0;
const cardsKey = cards => (cards || []).map(c => c.id || `${c.suit}:${c.rank}`).join(',');
const throwKey = room => room?.throwResult
  ? `${seq(room)}:${room.throwResult.seat}:${cardsKey(room.throwResult.allCards)}` : '';
const sameRound = (a,b) => a && b && a.code === b.code && a.round === b.round;

export function collectTableEvents(room, previous) {
  if (!sameRound(room,previous) || seq(room) < seq(previous)
    || !['playing','roundOver'].includes(room.phase)) return [];
  const events=[], scope=`${room.code}:${room.round}`;
  const add=(kind,key,detail={})=>events.push({kind,key:`${scope}:${key}`,...detail});
  const failed=room.throwResult?.failed;
  if (failed && throwKey(room)!==throwKey(previous)) {
    add('throw-fail',`failed:${throwKey(room)}`,{title:'甩牌失败',subtitle:'绷不住了！退牌重来',tag:'−10 分'});
  }
  const groups=[];
  if (seq(room)>seq(previous)) groups.push({
    plays:room.lastTrick||[], number:seq(room), kills:room.lastTrickKillSeats||[],
    winner:room.lastTrickWin?.winner,
    start:seq(room)===seq(previous)+1?(previous.currentTrick?.length||0):0
  });
  groups.push({plays:room.currentTrick||[],number:seq(room)+1,kills:room.trumpKillSeats||[],
    winner:room.currentWinnerSeat,start:seq(room)===seq(previous)?(previous.currentTrick?.length||0):0});
  for (const group of groups) {
    for (let i=group.start;i<group.plays.length;i++) {
      const play=group.plays[i], shape=play.shape||{}, key=`play:${group.number}:${i}:${play.seat}:${cardsKey(play.cards)}`;
      // A failed throw's kept pair/triple is part of the penalty, not a second show.
      if (failed && i===0 && play.seat===room.throwResult.seat) continue;
      if (group.kills.includes(play.seat)) {
        const priorKill=group.plays.slice(1,i).some(p=>group.kills.includes(p.seat));
        if (!priorKill || group.winner===play.seat) add(priorKill?'overkill':'bomb',key,
          {title:priorKill?'反杀！':'毙了！',subtitle:priorKill?'后手压制 · 火力全开':'主牌轰炸 · 全场震撼'});
      } else if (shape.type==='tractor') {
        add('tractor',key,{title:shape.unit===3?'三条拖拉机':'拖拉机！',
          subtitle:`${play.cards.length} 张连击 · 全速碾压`,tag:`${shape.count||play.cards.length/(shape.unit||2)} 连发`});
      } else if (shape.type==='throw' && i===0) {
        add('throw',key,{title:'甩牌成功',subtitle:'这一手，拿捏了！',tag:`${play.cards.length} 张齐出`});
      } else if (shape.type==='triple' && (i===0 || group.winner===play.seat)) {
        add('triple',key,{title:'三条压阵',subtitle:'三倍气场 · 强势出击'});
      }
    }
  }
  if (seq(room)>seq(previous) && room.lastTrickWin.points>=40 && room.phase!=='roundOver') {
    add('harvest',`harvest:${seq(room)}`,{title:'大丰收！',subtitle:'这波血赚',tag:`+${room.lastTrickWin.points} 分`});
  }
  if (room.phase==='roundOver' && previous.phase!=='roundOver' && room.lastResult) {
    const result=room.lastResult, viewer=room.viewerSeat;
    const dealerSide=viewer===room.dealerSeat || (room.fixedTeams
      ? viewer%2===room.dealerSeat%2 : viewer===room.friendSeat);
    const hasSide=Number.isInteger(viewer) && ['dealer','attackers'].includes(result.result?.side);
    const won=hasSide && (result.result.side==='dealer')===dealerSide;
    add(hasSide?(won?'victory':'defeat'):'finish','round-over',{
      title:won?(result.champion?'通关夺冠！':'本局胜利！'):hasSide?'下局再战':'本局结算',
      subtitle:result.result?.label||'这一局，打得精彩',
      tag:won&&result.result.steps>0?`升 ${result.result.steps} 级`:''
    });
  }
  return events;
}

const CONFIG = {
  tractor: {priority:60,sound:'tractor',duration:1500},
  bomb: {priority:75,sound:'bomb',duration:1350},
  overkill: {priority:80,sound:'bomb',duration:1450},
  'throw-fail': {priority:90,sound:'throw-fail',duration:1500},
  throw: {priority:65,sound:'throw-success',duration:1350},
  triple: {priority:45,sound:'triple',duration:1150},
  harvest: {priority:25,sound:'win',duration:1000},
  victory: {priority:100,sound:'celebrate',duration:1900},
  defeat: {priority:100,duration:1300},
  finish: {priority:100,sound:'win',duration:1400}
};
const CARDS='<b class="fx-card">♠</b><b class="fx-card">♥</b><b class="fx-card">♣</b><b class="fx-card">♦</b><b class="fx-card">♠</b>';
const ART = {
  tractor:'<div class="fx-track"></div><div class="fx-fire"></div><img class="fx-vehicle" src="/tractor-effect.svg" alt="" draggable="false">',
  bomb:'<img class="fx-bomb" src="/bomb-effect.svg" alt="" draggable="false">',
  overkill:'<img class="fx-bomb" src="/bomb-effect.svg" alt="" draggable="false"><span class="fx-cross">×</span>',
  throw:`<div class="fx-fan">${CARDS}</div>`,
  'throw-fail':'<div class="fx-shard fx-shard-left">♠</div><div class="fx-shard fx-shard-right">♠</div>',
  triple:`<div class="fx-triplet">${CARDS.slice(0,CARDS.indexOf('<b class="fx-card">♦'))}</div>`,
  harvest:'<span class="fx-symbol">✦</span>',
  victory:'<span class="fx-symbol fx-trophy">🏆</span>',
  defeat:'<span class="fx-symbol">♠</span>',
  finish:'<span class="fx-symbol">✦</span>'
};

// One scene at a time, at most two waiting scenes, bounded particles and timers.
// No game state, hand coordinates or hit targets are changed by this renderer.
export function createTableEffects({document:doc,window:win,sound=()=>{},root=()=>doc.querySelector('.table-felt')}={}) {
  let previous=null,scene=null,timer=null,queue=[],seen=new Set();
  let mode='full';
  try { const saved=win.localStorage.getItem('szp.effects');if(['full','lite','off'].includes(saved))mode=saved; } catch {}
  const effectiveMode=()=>mode==='off'?'off':win.matchMedia?.('(prefers-reduced-motion: reduce)').matches?'lite':mode;
  function clear() {
    win.clearTimeout(timer);timer=null;queue=[];scene?.remove();scene=null;
  }
  function next() {
    if (scene || !queue.length) return;
    const event=queue.shift(),config=CONFIG[event.kind],host=root(),effective=effectiveMode();
    if (!host || effective==='off' || doc.hidden) {queue=[];return;}
    scene=doc.createElement('div');scene.className=`table-fx fx-${event.kind} ${effective==='lite'?'fx-lite':''}`;
    scene.setAttribute('aria-hidden','true');scene.style.setProperty('--fx-duration',`${config.duration}ms`);
    scene.innerHTML=`<div class="fx-vignette"></div><div class="fx-rays"></div><div class="fx-ring"></div><div class="fx-ring fx-ring-two"></div><div class="fx-art">${ART[event.kind]}</div>`;
    const copy=doc.createElement('div');copy.className='fx-copy';
    for (const [tagName,className,text] of [['strong','fx-title',event.title],['span','fx-subtitle',event.subtitle],['b','fx-tag',event.tag]]) {
      if(!text)continue;const el=doc.createElement(tagName);el.className=className;el.textContent=text;copy.appendChild(el);
    }
    scene.appendChild(copy);
    if(effective==='full') {
      const count=win.matchMedia?.('(pointer: coarse)').matches?12:20;
      for(let i=0;i<count;i++) {
        const p=doc.createElement('i'),angle=i/count*Math.PI*2,distance=95+(i%4)*30;
        p.className='fx-spark';p.style.setProperty('--x',`${Math.cos(angle)*distance}px`);
        p.style.setProperty('--y',`${Math.sin(angle)*distance}px`);
        p.style.setProperty('--spin',`${i*73}deg`);p.style.setProperty('--delay',`${(i%5)*24}ms`);
        p.style.setProperty('--hue',`${i*47}deg`);scene.appendChild(p);
      }
    }
    host.appendChild(scene);
    try {if(config.sound)sound(config.sound);}catch {}
    timer=win.setTimeout(()=>{scene?.remove();scene=null;timer=null;next();},effective==='lite'?700:config.duration+60);
  }
  function play(event) {
    if(!CONFIG[event.kind] || effectiveMode()==='off' || doc.hidden)return;
    if(event.key&&seen.has(event.key))return;
    if(event.key){seen.add(event.key);if(seen.size>96)seen.delete(seen.values().next().value);}
    queue.push(event);queue.sort((a,b)=>CONFIG[b.kind].priority-CONFIG[a.kind].priority);
    queue=queue.slice(0,2);next();
  }
  return {
    get mode(){return mode;},
    get effectiveMode(){return effectiveMode();},
    setMode(value){if(!['full','lite','off'].includes(value))return;mode=value;clear();try{win.localStorage.setItem('szp.effects',value);}catch{}},
    reset(){clear();previous=null;seen.clear();},
    clear,
    play,
    update(room) {
      if(sameRound(room,previous)&&seq(room)<seq(previous))return;
      const events=collectTableEvents(room,previous);
      if(!sameRound(room,previous)){clear();seen.clear();}
      previous=room;
      if(!['playing','roundOver'].includes(room.phase)||doc.hidden){clear();return;}
      // Prefer the decisive play over a low-priority scoring flourish in one batch.
      events.sort((a,b)=>CONFIG[b.kind].priority-CONFIG[a.kind].priority);
      for(const event of events.slice(0,2))play(event);
    }
  };
}
