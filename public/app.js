import { unlock, sfx, speak, pick, toggleMusic, toggleVoice, setMusicVol, setFxVol, setMusicPhase, selectTrack, musicTracks, currentTrackId, audioState } from "./audio.js";

/* ─── State ──────────────────────────────────────────────── */
// Stable, client-owned player identity. Generated once and reused forever so we
// can always reclaim our seat after a refresh, app switch, or dropped connection.
function getMyId() {
  let id = localStorage.getItem("szp.playerId");
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) || `id_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    localStorage.setItem("szp.playerId", id);
  }
  return id;
}

const AVATARS = ["😀","😎","🤠","😺","🦊","🐼","🦁","🐯","🐸","🐵","🦄","🐲","👑","🎩","👻","🐰"];

const state = {
  ws: null,
  playerId: getMyId(),
  nickname: localStorage.getItem("szp.nickname") || "",
  avatar: localStorage.getItem("szp.avatar") || AVATARS[0],
  room: null,
  selected: new Set(),
  ping: { value: null, pendingAt: 0, lastPongAt: 0, timer: null, status: "bad" }
};

const $ = (sel) => document.querySelector(sel);

// Tracks the currently shown bid so the center reveal only re-animates on change
let lastBidSig = "";
let trickPauseRenderTimer = null;
// Card ids that have already played their deal-in animation, so re-renders during
// dealing don't make the whole hand flicker (only newly dealt cards animate).
const dealtCardIds = new Set();

// ─── Desktop UI scaling ──────────────────────────────────────
// On desktop (wide screens) enlarge the whole GUI; mobile stays pixel-identical.
// A single breakpoint decision here drives both the JS pixel math below and the
// CSS (via the body.desktop class), so the two never disagree.
const DESKTOP_MQ = window.matchMedia("(min-width: 1024px)");
let UI = DESKTOP_MQ.matches ? 1.35 : 1;
function applyUiScale() {
  UI = DESKTOP_MQ.matches ? 1.35 : 1;
  document.body.classList.toggle("desktop", UI > 1);
}
applyUiScale();
DESKTOP_MQ.addEventListener?.("change", () => {
  applyUiScale();
  if (state.room) render();
});

/* ─── Join Screen ────────────────────────────────────────── */
$("#nickname").value = state.nickname;

// Avatar picker on the join screen.
function buildAvatarPicker() {
  const picker = $("#avatarPicker");
  if (!picker) return;
  picker.innerHTML = AVATARS.map((a) =>
    `<button type="button" class="avatar-option ${a === state.avatar ? "selected" : ""}" data-avatar="${a}">${a}</button>`
  ).join("");
}
buildAvatarPicker();

function chooseAvatarFromEvent(event) {
  const btn = event.target.closest?.("[data-avatar]");
  if (!btn) return;
  event.preventDefault();
  state.avatar = btn.dataset.avatar;
  localStorage.setItem("szp.avatar", state.avatar);
  for (const option of $("#avatarPicker").querySelectorAll("[data-avatar]")) {
    option.classList.toggle("selected", option.dataset.avatar === state.avatar);
  }
}
$("#avatarPicker")?.addEventListener("click", chooseAvatarFromEvent);
$("#avatarPicker")?.addEventListener("touchend", chooseAvatarFromEvent, { passive: false });

$("#joinForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const code = $("#roomCode").value.trim();
  const seatCount = code ? undefined : Number($("#seatCountSel")?.value) || 5;
  connectAndJoin(code, $("#nickname").value.trim(), seatCount);
});

$("#createRoom").addEventListener("click", () => {
  connectAndJoin("", $("#nickname").value.trim(), Number($("#seatCountSel")?.value) || 5);
});

// 复制邀请链接（含房间码深链），朋友打开即自动填入房间码、一键加入。
async function copyInvite() {
  const code = state.room?.code;
  if (!code) return;
  const link = `${location.origin}/?room=${code}`;
  try { await navigator.clipboard.writeText(link); }
  catch { prompt("复制此邀请链接发给朋友：", link); return; }
  const btn = $("#copyInviteBtn");
  if (btn) { const old = btn.textContent; btn.textContent = "✓"; setTimeout(() => { btn.textContent = old; }, 1200); }
}
$("#copyInviteBtn")?.addEventListener("click", copyInvite);
$("#roomBadge")?.addEventListener("click", copyInvite);

// On load, prefill the last room code for convenience, but do NOT auto-join:
// a refresh should land on the join screen so the player can choose to re-enter
// or leave. (Mid-session app-switch reconnect is handled separately while a room
// is active.)
(() => {
  // 邀请深链 ?room=CODE 优先于上次房间码，便于朋友点链接一键进同一房间。
  const urlRoom = new URLSearchParams(location.search).get("room");
  const lastRoom = (urlRoom || localStorage.getItem("szp.roomCode") || "").trim().toUpperCase();
  if (lastRoom) $("#roomCode").value = lastRoom;
})();

function connectAndJoin(code, nickname, seatCount) {
  state.nickname = nickname || "玩家";
  state.createSeatCount = [4, 5, 6].includes(seatCount) ? seatCount : 5; // 仅创建房间时生效
  localStorage.setItem("szp.nickname", state.nickname);
  stopPingLoop();
  updatePingStatus("connecting");
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}`);
  state.ws = ws;
  ws.addEventListener("open", () => {
    updatePingStatus("connecting");
    startPingLoop();
  });
  ws.addEventListener("close", () => {
    stopPingLoop();
    updatePingStatus("down");
  });
  ws.addEventListener("error", () => {
    updatePingStatus("down");
  });
  // Only join once per socket. The server may send another "hello" after a
  // reconnect join; without this guard we'd loop hello→join→hello forever.
  let joined = false;
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "hello") {
      // Ignore the server's temporary id — we always identify with our stable id
      // so the server keys our seat by it and reconnects map back to us.
      if (!joined) {
        joined = true;
        state.playerId = getMyId();
        send(code ? "joinRoom" : "createRoom", { code, nickname: state.nickname, playerId: state.playerId, seatCount: state.createSeatCount });
      }
    }
    if (msg.type === "pong") {
      receivePong(msg.payload);
    }
    if (msg.type === "state") {
      handleAudioEvents(msg.payload);
      setMusicPhase(msg.payload.phase === "lobby" ? "lobby" : "game"); // 大厅放开场，开打后切牌局曲
      state.room = msg.payload;
      // Remember the room so a refresh / reopen can auto-reconnect us back in.
      if (state.room.code) localStorage.setItem("szp.roomCode", state.room.code);
      // Preserve selected cards that are still in hand
      const hand = msg.payload.seats.find(s => s.isYou)?.hand || [];
      const handIds = new Set(hand.map(c => c.id));
      for (const id of [...state.selected]) {
        if (!handIds.has(id)) state.selected.delete(id);
      }
      render();
    }
    if (msg.type === "emote") playEmote(msg.payload);
    if (msg.type === "kickVote") showKickVotePrompt(msg.payload);
    if (msg.type === "kicked") handleKicked(msg.payload);
    if (msg.type === "hint") applyHint(msg.payload);
    if (msg.type === "error") showError(msg.payload.message);
  });
}

function send(type, payload = {}) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return false;
  state.ws.send(JSON.stringify({ type, payload }));
  return true;
}

/* ─── Sound & voice callouts (斗地主 style) ────────────────── */
let audioPrev = null;
function isTrumpCard(c, room) {
  if (!c) return false;
  if (c.suit === "joker") return true;
  if (c.rank === room.levelRank) return true;
  if (!room.noTrump && c.suit === room.trumpSuit) return true;
  return false;
}
function handleAudioEvents(room) {
  if (!room) return;
  const snap = {
    seq: room.lastTrickWin?.seq || 0,
    trickLen: room.currentTrick?.length || 0,
    logLen: room.tableLog?.length || 0,
    phase: room.phase
  };
  const prev = audioPrev;
  audioPrev = snap;
  if (!prev) return; // first state — nothing to compare against
  const trick = room.currentTrick || [];

  // a new card was played this trick
  if (snap.trickLen > prev.trickLen && snap.trickLen > 0) {
    sfx("play");
    const last = trick[trick.length - 1];
    const isLead = trick.length === 1;
    const isTractor = last?.shape?.type === "tractor";
    const allTrump = last && last.cards.length && last.cards.every((c) => isTrumpCard(c, room));
    const isKill = Array.isArray(room.trumpKillSeats) && room.trumpKillSeats.includes(last?.seat);
    const tookLead = !isLead && room.currentWinnerSeat === last?.seat;
    if (isTractor) { sfx("tractor"); speak("拖拉机！"); }                 // 拖拉机=火车音效
    // 领出主牌＝调主(diào zhǔ)拔主。TTS 会把"调"误读成 tiáo，故用同音的"吊"逼出 diào。
    else if (isLead && allTrump) speak(pick(["吊主！", "吊主！", "拔主咯！"]));
    else if (isKill) { sfx("kill"); speak(pick(["杀！", "毙！", "大你！"])); }
    else if (tookLead) speak(pick(["大你！", "管上！", "压你一头！"]));
  }
  // a trick was just won
  if (snap.seq > prev.seq) sfx("win");
  // round just ended → 夺冠播报
  if (snap.phase === "roundOver" && prev.phase !== "roundOver" && room.lastResult?.champion) {
    sfx("win"); speak("夺冠啦！");
  }
  // new log lines → 甩牌 / 亮主 callouts
  if (snap.logLen > prev.logLen && Array.isArray(room.tableLog)) {
    for (const line of room.tableLog.slice(prev.logLen)) {
      // 只在"真正亮主/亮庄"那一刻播报：实际宣告含全角冒号(亮主：/亮庄：)；
      // 其余如"亮主者坐庄""无人亮主""重新叫主"都是提示语，不应触发。
      if (line.includes("甩牌：")) speak("甩牌！");
      else if (line.includes("亮主：") || line.includes("亮庄：")) speak(pick(["亮主！", "我来定主！", "这主我来定！"]));
    }
  }
}

function scheduleTrickPauseRefresh(room) {
  if (trickPauseRenderTimer) {
    clearTimeout(trickPauseRenderTimer);
    trickPauseRenderTimer = null;
  }
  const remaining = (room?.trickPauseUntil || 0) - Date.now();
  if (room?.phase !== "playing" || remaining <= 0) return;
  trickPauseRenderTimer = setTimeout(() => {
    trickPauseRenderTimer = null;
    if (state.room) render();
  }, remaining + 30);
}

function startPingLoop() {
  stopPingLoop();
  sendPing();
  state.ping.timer = setInterval(sendPing, 3000);
}

function stopPingLoop() {
  if (state.ping.timer) clearInterval(state.ping.timer);
  state.ping.timer = null;
  state.ping.pendingAt = 0;
}

function sendPing() {
  const ws = state.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    updatePingStatus("down");
    return;
  }
  const now = Date.now();
  if (state.ping.pendingAt && now - state.ping.pendingAt > 6000) {
    updatePingStatus("stale");
  }
  state.ping.pendingAt = now;
  send("ping", { sentAt: now });
}

function receivePong(payload = {}) {
  const sentAt = Number(payload.sentAt) || state.ping.pendingAt || Date.now();
  state.ping.value = Math.max(0, Date.now() - sentAt);
  state.ping.pendingAt = 0;
  state.ping.lastPongAt = Date.now();
  updatePingStatus("ok");
}

function updatePingStatus(mode = "ok") {
  const el = $("#pingStatus");
  if (!el) return;
  el.classList.remove("good", "warn", "bad");
  if (mode === "down") {
    el.textContent = "服务器断开";
    el.classList.add("bad");
    return;
  }
  if (mode === "stale") {
    el.textContent = "服务器无响应";
    el.classList.add("bad");
    return;
  }
  if (mode === "connecting" || state.ping.value == null) {
    el.textContent = "连接中…";
    el.classList.add("warn");
    return;
  }
  const ping = Math.round(state.ping.value);
  el.textContent = `Ping ${ping}ms`;
  el.classList.add(ping < 120 ? "good" : ping < 300 ? "warn" : "bad");
}

// 推荐出牌：服务器返回建议的 cardId，自动帮玩家选中，玩家确认后再点“出牌”。
function applyHint(payload) {
  const ids = payload?.cardIds || [];
  if (!ids.length) { showError("暂无推荐出牌"); return; }
  state.selected = new Set(ids);
  if (state.room) render();
}

/* ─── Root Render ────────────────────────────────────────── */
function render() {
  document.querySelector('[data-view="join"]').classList.add("hidden");
  document.querySelector('[data-view="game"]').classList.remove("hidden");

  const room = state.room;
  scheduleTrickPauseRefresh(room);
  $("#roomBadge").textContent = `房间 ${room.code}`;
  $("#phaseBadge").textContent = phaseText(room.phase);

  const trump = room.noTrump ? "无主" : (room.trumpSuit ? suitSymbolColored(room.trumpSuit) : "-");
  $("#roundInfo").innerHTML = `第${room.round || 0}局 · 打${room.levelRank || "-"} · 主${trump}`;
  const kickBtn = $("#kickBtn");
  if (kickBtn) {
    const seated = room.seats.some((s) => s.isYou);
    kickBtn.disabled = !seated;
    kickBtn.style.display = seated ? "" : "none";
  }

  try { renderSeats(room); }    catch(e) { console.error("renderSeats:", e); }
  try { renderCenter(room); }   catch(e) { console.error("renderCenter:", e); }
  try { renderControls(room); } catch(e) { console.error("renderControls:", e); }
  try { renderTrusteeControls(room); } catch(e) { console.error("renderTrusteeControls:", e); }
  try { renderHand(room); }     catch(e) { console.error("renderHand:", e); }
  try { renderSpectators(room); } catch(e) { console.error("renderSpectators:", e); }
  try { renderLog(room); }      catch(e) { console.error("renderLog:", e); }
  try { maybeAnimateTrickPoints(room); } catch(e) { console.error("trickPoints:", e); }
  try { maybeAnimateFriendReveal(room); } catch(e) { console.error("friendReveal:", e); }
  if ($("#logPanel")?.classList.contains("open")) { try { renderLog(room); } catch(e) { console.error("renderLog:", e); } }
  if ($("#standingsPanel")?.classList.contains("open")) { try { renderStandings(room); } catch(e) { console.error("standings:", e); } }
  try { maybeAnimateChampion(room); } catch(e) { console.error("champion:", e); }
}

// Spectators (joined but not seated) — listed small in the table's top-left.
function renderSpectators(room) {
  const el = $("#spectatorList");
  if (!el) return;
  const names = room.spectators || [];
  if (names.length === 0) {
    el.innerHTML = "";
    el.style.display = "none";
    return;
  }
  el.style.display = "block";
  el.innerHTML = `<div class="spectator-title">观战 ${names.length}</div>` +
    names.map((n) => `<div class="spectator-name">${escapeHtml(n)}</div>`).join("");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ─── Emotes: throw tomato / send flower at a player's avatar ─── */
let emoteMenuEl = null;
// 可投掷物：表情、命中后的粒子、命中是否抖动（友好的=放大）。
const EMOTES = {
  tomato: { emoji: "🍅", parts: ["🍅", "💥", "🍅", "💦"], shake: true },
  flower: { emoji: "🌹", parts: ["🌸", "🌷", "💕", "✨", "🌹"], shake: false },
  poop:   { emoji: "💩", parts: ["💩", "💩", "🪰", "💨"], shake: true },
  pig:    { emoji: "🐷", parts: ["🐷", "💢", "💥", "🐽"], shake: true },
  coffee: { emoji: "☕", parts: ["☕", "💦", "💧", "♨️"], shake: true }
};
function openEmoteMenu(targetIndex, anchorEl) {
  closeEmoteMenu();
  const menu = document.createElement("div");
  menu.className = "emote-menu";
  menu.innerHTML = `
    <button class="emote-btn" data-kind="tomato" title="砸西红柿">🍅</button>
    <button class="emote-btn" data-kind="flower" title="送花">🌹</button>
    <button class="emote-btn" data-kind="poop" title="扔大便">💩</button>
    <button class="emote-btn" data-kind="pig" title="扔猪头">🐷</button>
    <button class="emote-btn" data-kind="coffee" title="泼咖啡">☕</button>`;
  document.body.appendChild(menu);
  const r = anchorEl.getBoundingClientRect();
  menu.style.left = `${r.left + r.width / 2}px`;
  menu.style.top = `${r.top - 6}px`;
  // 手机端：靠边座位时把菜单水平夹在屏幕内，避免被裁掉
  requestAnimationFrame(() => {
    const mr = menu.getBoundingClientRect();
    const half = mr.width / 2, pad = 8;
    let left = r.left + r.width / 2;
    left = Math.max(pad + half, Math.min(window.innerWidth - pad - half, left));
    menu.style.left = `${left}px`;
  });
  menu.querySelectorAll("[data-kind]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      send("emote", { target: targetIndex, kind: b.dataset.kind });
      closeEmoteMenu();
    }));
  emoteMenuEl = menu;
  setTimeout(() => document.addEventListener("click", closeEmoteMenu, { once: true }), 0);
}
function closeEmoteMenu() {
  if (emoteMenuEl) { emoteMenuEl.remove(); emoteMenuEl = null; }
}

function seatTokenEl(seatIndex) {
  const viewer = state.room?.viewerSeat ?? 0;
  const pos = seatToScreenPos(seatIndex, viewer, state.room?.seatCount || 5);
  return document.querySelector(`.seat.screen-pos-${pos} .seat-token`);
}

function playEmote({ from, target, kind }) {
  const targetEl = seatTokenEl(target);
  if (!targetEl) return;
  const tr = targetEl.getBoundingClientRect();
  const endX = tr.left + tr.width / 2;
  const endY = tr.top + tr.height / 2;
  let startX = window.innerWidth / 2;
  let startY = window.innerHeight - 60;
  if (from != null) {
    const fromEl = seatTokenEl(from);
    if (fromEl) { const fr = fromEl.getBoundingClientRect(); startX = fr.left + fr.width / 2; startY = fr.top + fr.height / 2; }
  }
  const def = EMOTES[kind] || EMOTES.tomato;
  const proj = document.createElement("div");
  proj.className = "emote-proj";
  proj.textContent = def.emoji;
  proj.style.left = `${startX}px`;
  proj.style.top = `${startY}px`;
  document.body.appendChild(proj);
  const dx = endX - startX, dy = endY - startY;
  const anim = proj.animate([
    { transform: "translate(-50%,-50%) translate(0,0) scale(.5) rotate(0deg)", opacity: 1, offset: 0 },
    { transform: `translate(-50%,-50%) translate(${dx * 0.5}px, ${dy * 0.5 - 90}px) scale(1.15) rotate(200deg)`, opacity: 1, offset: 0.6 },
    { transform: `translate(-50%,-50%) translate(${dx}px, ${dy}px) scale(1) rotate(340deg)`, opacity: 1, offset: 1 }
  ], { duration: 620, easing: "cubic-bezier(.4,.1,.5,1)" });
  anim.onfinish = () => {
    proj.remove();
    emoteBurst(endX, endY, kind);
    targetEl.animate(
      def.shake
        ? [{ transform: "translate(0,0)" }, { transform: "translate(-4px,2px)" }, { transform: "translate(4px,-2px)" }, { transform: "translate(-3px,1px)" }, { transform: "translate(0,0)" }]
        : [{ transform: "scale(1)" }, { transform: "scale(1.14)" }, { transform: "scale(1)" }],
      { duration: 440, easing: "ease-out" });
  };
}

function emoteBurst(x, y, kind) {
  const particles = (EMOTES[kind] || EMOTES.tomato).parts;
  const n = 8;
  for (let i = 0; i < n; i++) {
    const p = document.createElement("div");
    p.className = "emote-particle";
    p.textContent = particles[i % particles.length];
    p.style.left = `${x}px`;
    p.style.top = `${y}px`;
    document.body.appendChild(p);
    const ang = (Math.PI * 2 * i) / n + Math.random() * 0.5;
    const dist = 30 + Math.random() * 42;
    p.animate([
      { transform: "translate(-50%,-50%) translate(0,0) scale(1)", opacity: 1 },
      { transform: `translate(-50%,-50%) translate(${Math.cos(ang) * dist}px, ${Math.sin(ang) * dist + 20}px) scale(.4)`, opacity: 0 }
    ], { duration: 700 + Math.random() * 220, easing: "cubic-bezier(.2,.6,.4,1)" }).onfinish = () => p.remove();
  }
  const splat = document.createElement("div");
  splat.className = `emote-splat ${kind}`;
  splat.style.left = `${x}px`;
  splat.style.top = `${y}px`;
  document.body.appendChild(splat);
  splat.animate([
    { transform: "translate(-50%,-50%) scale(.2)", opacity: .85 },
    { transform: "translate(-50%,-50%) scale(1.35)", opacity: 0 }
  ], { duration: 600, easing: "ease-out" }).onfinish = () => splat.remove();
}

/* ─── Friend reveal flash ────────────────────────────────── */
// 找朋友玩法最高潮的“敌我翻转”瞬间。靠 friendReveal.seq 检测这一次现身（每局一次）。
let lastFriendSeq = null;
function maybeAnimateFriendReveal(room) {
  const info = room.friendReveal;
  const seq = info?.seq ?? 0;
  if (lastFriendSeq === null) { lastFriendSeq = seq; return; } // 首帧同步，不补播历史
  if (seq === lastFriendSeq) return;
  lastFriendSeq = seq;
  if (info) animateFriendReveal(info.seat);
}
function animateFriendReveal(seatIndex) {
  const el = seatTokenEl(seatIndex);
  if (!el) return;
  el.animate([
    { boxShadow: "0 0 0 0 rgba(255,216,77,.9)", transform: "scale(1)" },
    { boxShadow: "0 0 0 16px rgba(255,216,77,0)", transform: "scale(1.22)", offset: .45 },
    { boxShadow: "0 0 0 0 rgba(255,216,77,0)", transform: "scale(1)" }
  ], { duration: 1000, easing: "ease-out" });
  const r = el.getBoundingClientRect();
  const tag = document.createElement("div");
  tag.className = "friend-pop";
  tag.textContent = "🤝 朋友现身！";
  tag.style.left = `${r.left + r.width / 2}px`;
  tag.style.top = `${r.top}px`;
  document.body.appendChild(tag);
  tag.animate([
    { transform: "translate(-50%,-50%) scale(.6)", opacity: 0 },
    { transform: "translate(-50%,-150%) scale(1.15)", opacity: 1, offset: .3 },
    { transform: "translate(-50%,-190%) scale(1)", opacity: 1, offset: .8 },
    { transform: "translate(-50%,-230%) scale(.9)", opacity: 0 }
  ], { duration: 1700, easing: "cubic-bezier(.2,.7,.3,1)" }).onfinish = () => tag.remove();
}

/* ─── Trick points fly-to-winner animation ──────────────── */
let lastTrickSeq = null;
function maybeAnimateTrickPoints(room) {
  const info = room.lastTrickWin;
  const seq = info?.seq ?? 0;
  if (lastTrickSeq === null) { lastTrickSeq = seq; return; } // first state: sync, no animation
  if (seq === lastTrickSeq) return;
  lastTrickSeq = seq;
  if (info && info.points > 0) animateTrickPoints(info.winner, info.points);
}

function animateTrickPoints(winnerSeat, points) {
  const targetEl = seatTokenEl(winnerSeat);
  if (!targetEl) return;
  const tr = targetEl.getBoundingClientRect();
  const endX = tr.left + tr.width / 2;
  const endY = tr.top + tr.height / 2;
  const center = document.querySelector(".table-center");
  let startX = window.innerWidth / 2;
  let startY = window.innerHeight / 2;
  if (center) { const cr = center.getBoundingClientRect(); startX = cr.left + cr.width / 2; startY = cr.top + cr.height / 2; }

  const el = document.createElement("div");
  el.className = "points-fly";
  el.textContent = `+${points} 分`;
  el.style.left = `${startX}px`;
  el.style.top = `${startY}px`;
  document.body.appendChild(el);
  const dx = endX - startX, dy = endY - startY;
  el.animate([
    { transform: "translate(-50%,-50%) scale(.5)", opacity: 0, offset: 0 },
    { transform: "translate(-50%,-50%) scale(1.3)", opacity: 1, offset: .16 },
    { transform: `translate(-50%,-50%) translate(${dx * 0.5}px, ${dy * 0.5}px) scale(1.05)`, opacity: 1, offset: .6 },
    { transform: `translate(-50%,-50%) translate(${dx}px, ${dy}px) scale(.85)`, opacity: 1, offset: .92 },
    { transform: `translate(-50%,-50%) translate(${dx}px, ${dy}px) scale(.4)`, opacity: 0, offset: 1 }
  ], { duration: 1150, easing: "cubic-bezier(.35,.1,.25,1)" }).onfinish = () => {
    el.remove();
    targetEl.animate(
      [{ transform: "scale(1)" }, { transform: "scale(1.18)" }, { transform: "scale(1)" }],
      { duration: 420, easing: "ease-out" });
  };
}

/* ─── Seats + Played Cards ───────────────────────────────── */
/* ─── Seats + Played Cards ───────────────────────────────── */
// Screen positions (0=bottom-center/you, 1=bottom-right, 2=top-right, 3=top-left, 4=bottom-left)
function seatToScreenPos(serverIndex, viewerSeatIndex, seatCount) {
  return (serverIndex - viewerSeatIndex + seatCount) % seatCount;
}

function renderSeats(room) {
  const seatsEl = document.querySelector("#seats");
  seatsEl.className = `seats players-${room.seatCount || 5}`;

  const currentPlayed = {};
  for (const play of room.currentTrick) currentPlayed[play.seat] = play.cards;
  const lastPlayed = {};
  for (const play of (room.lastTrick || [])) lastPlayed[play.seat] = play.cards;
  const currentKillSeats = new Set(room.trumpKillSeats || []);
  const completedWinner = room.currentTrick.length === 0 ? room.lastTrickWin?.winner : null;

  const isDealer = (i) => room.dealerSeat === i;
  const myParity = (room.viewerSeat ?? 0) % 2;
  const isFriend = (i) => room.fixedTeams
    ? (i !== (room.viewerSeat ?? 0) && i % 2 === myParity) // 6人固定队：与自己同奇偶（隔座）的是队友
    : (room.friendSeat !== null && room.friendSeat === i);
  const friendRevealed = room.fixedTeams || room.friendSeat !== null;
  const inBiddingPhase = ["dealing","auctionReady","auction","sixTrump"].includes(room.phase);
  const showBids = ["dealing","auctionReady","auction","forcedSuit","sixTrump","burying"].includes(room.phase);
  const seatBids = room.seatBids || {};
  const bidResponses = room.bidResponses || {};
  const viewerSeatIndex = room.viewerSeat ?? 0;

  seatsEl.innerHTML = room.seats.map((seat) => {
    const screenPos = seatToScreenPos(seat.index, viewerSeatIndex, room.seatCount || 5);
    const initial = escapeHtml((seat.nickname || "?")[0].toUpperCase());
    const isActive = room.phase === "playing" && room.turnSeat === seat.index;
    const youClass = seat.isYou ? "you" : "";
    const activeClass = isActive ? "active" : "";

    // Role badge
    let roleBadge = "";
    if (isDealer(seat.index) && room.dealerSeat !== null) {
      roleBadge = `<div class="role-badge dealer-badge">庄</div>`;
    } else if (isFriend(seat.index)) {
      roleBadge = `<div class="role-badge friend-badge">友</div>`;
    }

    // Bid response indicator
    let bidIndicator = "";
    if (inBiddingPhase) {
      const resp = bidResponses[seat.index];
      if (resp === "pass") bidIndicator = `<div class="bid-indicator pass">${room.phase === "sixTrump" ? "不亮" : "不抢"}</div>`;
    }

    // Cards beside seat — bottom seats (pos 1,4) show cards ABOVE the token
    const playedAbove = screenPos === 1 || screenPos === (room.seatCount || 5) - 1;
    let sideCardsHTML = "";
    let currentPlayShown = false;
    let completedPlayShown = false;
    if (showBids && seatBids[seat.index]) {
      sideCardsHTML = renderPlayedCards(seatBids[seat.index].cards);
    } else {
      let playedCards = null;
      if (currentPlayed[seat.index]) {
        playedCards = currentPlayed[seat.index];
        currentPlayShown = true;
      } else if (room.currentTrick.length === 0 && lastPlayed[seat.index]) {
        playedCards = lastPlayed[seat.index];
        completedPlayShown = true;
      }
      if (playedCards) sideCardsHTML = renderPlayedCards(playedCards);
    }
    // 进行中和一墩结束后都只高亮本墩“最大”的唯一一家。
    const winningPlay = (currentPlayShown && room.currentWinnerSeat === seat.index)
      || (completedPlayShown && completedWinner === seat.index);
    const killPlay = currentPlayShown && currentKillSeats.has(seat.index);

    // Personal score
    let personalScore = "";
    if (room.phase === "playing" || room.phase === "roundOver") {
      if (!friendRevealed && !isDealer(seat.index) && seat.playerId) {
        const ps = (room.seatPersonalScores || {})[seat.index] ?? 0;
        const pts = seat.takenTrickPoints + ps;
        const color = pts < 0 ? "#ff6b6b" : "var(--gold-light)";
        personalScore = `<div class="personal-score" style="color:${color}">${pts}分</div>`;
      }
    }

    // Seat action buttons (lobby only)
    let actionsHTML = "";
    if (room.phase === "lobby") {
      if (!seat.playerId) {
        actionsHTML = `<div class="seat-actions">
          <button class="seat-btn" data-sit="${seat.index}">坐下</button>
          <div class="ai-add">
            <span class="ai-add-label">加AI</span>
            <button class="seat-btn ai-lv" data-ai="${seat.index}" data-level="easy" title="弱：被动跟最小牌">弱</button>
            <button class="seat-btn ai-lv" data-ai="${seat.index}" data-level="medium" title="中：稳健抢墩、喂分、会抢庄">中</button>
            <button class="seat-btn ai-lv" data-ai="${seat.index}" data-level="hard" title="强：记牌器 + 轻量搜索推演，会算牌、拔主、积极抢庄（近乎秒出）">强</button>
            <button class="seat-btn ai-lv ai-lv-master" data-ai="${seat.index}" data-level="master" title="大师：记牌器 + 深度蒙特卡洛搜索，逐步推演选最优出牌（最强，出牌略慢）">大师</button>
          </div>
        </div>`;
      } else if (seat.isYou) {
        actionsHTML = `<div class="seat-actions"><button class="seat-btn" data-leave>离座</button></div>`;
      } else if (seat.isAi && room.viewerSeat == null) {
        actionsHTML = `<div class="seat-actions"><button class="seat-btn" data-takeover="${seat.index}" title="接管这个 AI 座位继续打">接管AI</button></div>`;
      } else if (seat.isAi) {
        actionsHTML = `<div class="seat-actions"><button class="seat-btn" data-kick="${seat.index}" title="踢掉这个 AI，让真人坐下">踢掉</button></div>`;
      }
    } else if (seat.isAi && room.viewerSeat == null) {
      actionsHTML = `<div class="seat-actions"><button class="seat-btn" data-takeover="${seat.index}" title="接管这个 AI 座位继续打">接管AI</button></div>`;
    }

    const levelText = seat.level ? `Lv.${seat.level}` : "";
    const statusText = seat.playerId
      ? `${seat.isAi ? "AI" : (seat.trustee ? "托管" : (seat.connected ? "在线" : "离线"))} · ${seat.handCount}张`
      : "空座";

    const playedClasses = [
      "seat-played",
      winningPlay ? "winning" : "",
      killPlay ? "trump-kill" : ""
    ].filter(Boolean).join(" ");
    const playedDiv = sideCardsHTML
      ? `<div class="${playedClasses}">${sideCardsHTML}</div>`
      : "";

    return `<div class="seat screen-pos-${screenPos} ${youClass} ${activeClass}">
      ${playedAbove ? playedDiv : ""}
      <div class="seat-token-wrap">
        ${roleBadge}
        <div class="seat-token ${seat.avatar ? "has-avatar" : ""} ${seat.playerId && !seat.isYou ? "emote-target" : ""}"${seat.playerId && !seat.isYou ? ` data-emote="${seat.index}"` : ""}>${seat.avatar ? escapeHtml(seat.avatar) : initial}</div>
        ${personalScore}
      </div>
      <div class="seat-name">${escapeHtml(seat.nickname || `座位${seat.index + 1}`)}</div>
      <div class="seat-info">${statusText}${levelText ? " · " + levelText : ""}</div>
      ${bidIndicator}
      ${actionsHTML}
      ${!playedAbove ? playedDiv : ""}
    </div>`;
  }).join("");

  seatsEl.querySelectorAll("[data-emote]").forEach(el =>
    el.addEventListener("click", (e) => { e.stopPropagation(); openEmoteMenu(Number(el.dataset.emote), el); }));

  seatsEl.querySelectorAll("[data-sit]").forEach(btn =>
    btn.addEventListener("click", () => send("sit", { seatIndex: Number(btn.dataset.sit), nickname: state.nickname, avatar: state.avatar })));
  seatsEl.querySelectorAll("[data-ai]").forEach(btn =>
    btn.addEventListener("click", () => send("addAi", { seatIndex: Number(btn.dataset.ai), level: btn.dataset.level || "medium" })));
  seatsEl.querySelectorAll("[data-leave]").forEach(btn =>
    btn.addEventListener("click", () => send("leaveSeat")));
  seatsEl.querySelectorAll("[data-kick]").forEach(btn =>
    btn.addEventListener("click", () => send("kickAi", { seatIndex: Number(btn.dataset.kick) })));
  seatsEl.querySelectorAll("[data-takeover]").forEach(btn =>
    btn.addEventListener("click", () => send("takeoverAi", { seatIndex: Number(btn.dataset.takeover), nickname: state.nickname, avatar: state.avatar })));
}

/* ─── Played Cards HTML (beside seat) ───────────────────── */
function renderPlayedCards(cards) {
  if (!cards || cards.length === 0) return "";

  // 6 人座位更密，牌片与容器都收窄，避免侧位出牌横扫顶部中央座位。
  const sixP = (state.room?.seatCount || 5) === 6;
  const CARD_W = Math.round((sixP ? 44 : 50) * UI);
  const CARD_H = Math.round((sixP ? 62 : 71) * UI);
  // Max container width available beside a seat (keep it compact)
  const MAX_WIDTH = Math.round((sixP ? 104 : 170) * UI);
  // Calculate offset per card so all fit within MAX_WIDTH
  const offset = cards.length === 1
    ? 0
    : Math.min(Math.round((sixP ? 18 : 34) * UI), Math.floor((MAX_WIDTH - CARD_W) / (cards.length - 1)));
  const totalWidth = CARD_W + (cards.length - 1) * offset;

  const inner = cards.map((card, i) =>
    `<div style="position:absolute;left:${i * offset}px;top:0;z-index:${i + 1};">
      ${playedCardHTML(card)}
    </div>`
  ).join("");

  return `<div style="position:relative;width:${totalWidth}px;height:${CARD_H}px;flex-shrink:0;">${inner}</div>`;
}

function playedCardHTML(card) {
  const colorClass = isRed(card) ? "red" : (card.suit === "joker" ? "joker" : "black");
  const jokerClass = card.rank === "bigJoker" ? "big-joker" : "";

  if (card.rank === "bigJoker" || card.rank === "smallJoker") {
    const label = card.rank === "bigJoker" ? "大" : "小";
    const jokerTop = card.rank === "bigJoker" ? "JOKER" : "Joker";
    return `
      <div class="played-card joker ${jokerClass}">
        <div class="card-corner">
          <div class="card-rank" style="font-size:8px">${jokerTop}</div>
        </div>
        <div class="card-center joker-text">${label}王</div>
        <div class="card-corner bottom">
          <div class="card-rank" style="font-size:8px">${jokerTop}</div>
        </div>
      </div>`;
  }

  return `
    <div class="played-card ${colorClass}">
      <div class="card-corner">
        <div class="card-rank">${rankText(card.rank)}</div>
        <div class="card-suit-sm">${suitSymbol(card.suit)}</div>
      </div>
      <div class="card-center">${suitSymbol(card.suit)}</div>
      <div class="card-corner bottom">
        <div class="card-rank">${rankText(card.rank)}</div>
        <div class="card-suit-sm">${suitSymbol(card.suit)}</div>
      </div>
    </div>`;
}

/* ─── Center Table Info ──────────────────────────────────── */
function renderCenter(room) {
  // Score display: show team scores only after friend is revealed
  // （6 人固定队从开局就已知队伍，直接显示）
  const friendRevealed = room.fixedTeams || room.friendSeat !== null;
  if (friendRevealed || room.phase === "roundOver") {
    const penalties = throwPenaltyLines(room);
    $("#scoreInfo").innerHTML = `
      <div class="score-main">闲家分数 ${room.scores.attackers} 分</div>
      ${penalties.length ? `<div class="score-sub">${penalties.join("<br>")}</div>` : ""}`;
  } else {
    $("#scoreInfo").innerHTML = "";
  }
  $("#turnInfo").textContent = room.turnSeat != null && room.phase === "playing"
    ? `轮到：${seatName(room, room.turnSeat)}`
    : "";

  // Current declared trump ("亮主") shown prominently in the center with a pop
  // animation whenever someone bids / counters (反主/加固).
  renderBidReveal(room);

  // Friend announcement banner — shown after the dealer calls a friend and stays
  // until the friend is revealed (the matching card is played), then disappears.
  const friendBanner = $("#friendBanner");
  if (room.friendCall && room.friendSeat === null) {
    const fc = room.friendCall;
    const label = (fc.rank === "bigJoker" || fc.rank === "smallJoker")
      ? rankText(fc.rank)
      : `${suitSymbolColored(fc.suit)}${fc.rank}`;
    friendBanner.innerHTML = `朋友是第 ${fc.ordinal} 张 ${label}`;
    friendBanner.style.display = "block";
  } else {
    friendBanner.textContent = "";
    friendBanner.style.display = "none";
  }

  // Revealed kitty during auction
  let kittyEl = document.getElementById("revealedKittyDisplay");
  if (!kittyEl) {
    kittyEl = document.createElement("div");
    kittyEl.id = "revealedKittyDisplay";
    kittyEl.style.cssText = "display:flex;gap:4px;flex-wrap:wrap;justify-content:center;margin-top:6px;";
    document.querySelector(".table-center").appendChild(kittyEl);
  }

  if (room.revealedKitty && room.revealedKitty.length > 0 && ["auction","auctionReady","forcedSuit"].includes(room.phase)) {
    kittyEl.innerHTML = room.revealedKitty.map((card) => playedCardHTML(card)).join("");
    kittyEl.style.display = "flex";
  } else {
    kittyEl.innerHTML = "";
    kittyEl.style.display = "none";
  }

  // Throw result display (shown for 2s client-side via CSS animation)
  let throwEl = document.getElementById("throwResultDisplay");
  if (!throwEl) {
    throwEl = document.createElement("div");
    throwEl.id = "throwResultDisplay";
    throwEl.style.cssText = `
      margin-top: 8px;
      display: none;
      flex-direction: column;
      align-items: center;
      gap: 6px;
    `;
    document.querySelector(".table-center").appendChild(throwEl);
  }

  if (room.throwResult) {
    const tr = room.throwResult;
    const allCardsHTML = tr.allCards.map((c) => playedCardHTML(c)).join("");
    const statusColor = tr.failed ? "#ff6b6b" : "#4fc3f7";
    const statusText = tr.failed ? `甩牌失败：${tr.message}` : "甩牌成功";
    throwEl.innerHTML = `
      <div style="display:flex;gap:3px;flex-wrap:wrap;justify-content:center">${allCardsHTML}</div>
      <div style="font-size:12px;color:${statusColor};text-shadow:0 1px 3px rgba(0,0,0,.8)">${statusText}</div>
      ${tr.failed ? `<div style="font-size:11px;color:rgba(255,255,255,.6)">保留：${tr.keepCards.map(c=>c.label).join("、")}</div>` : ""}
    `;
    throwEl.style.display = "flex";
  } else {
    throwEl.innerHTML = "";
    throwEl.style.display = "none";
  }
  let resultEl = document.getElementById("roundResultDisplay");
  if (!resultEl) {
    resultEl = document.createElement("div");
    resultEl.id = "roundResultDisplay";
    resultEl.style.cssText = `
      margin-top: 8px;
      padding: 10px 16px;
      background: rgba(0,0,0,.6);
      border: 1px solid rgba(200,144,45,.5);
      border-radius: 8px;
      color: #e8b84b;
      font-size: 13px;
      text-align: center;
      line-height: 1.7;
    `;
    document.querySelector(".table-center").appendChild(resultEl);
  }

  if (room.phase === "roundOver" && room.lastResult) {
    const r = room.lastResult;
    const champLine = r.champion
      ? `<div class="champ-banner">🏆 ${r.champion === "dealer" ? "庄家队" : "闲家队"} 打过 A，夺冠！</div>`
      : "";
    const kittyCards = (r.hiddenKitty || []).map((c) => `<div class="kitty-mini-card">${playedCardHTML(c)}</div>`).join("");
    const kittyLine = kittyCards
      ? `<div class="round-kitty-row">${kittyCards}</div>`
      : "";
    const lines = [
      `本局闲家得分：${r.attackers} 分`,
      r.buriedBonus > 0 ? `底牌加成：+${r.buriedBonus} 分` : null,
      `结果：${r.result.label}`,
      r.result.steps > 0 && r.upgradedSeats && r.upgradedSeats.length > 0
        ? `升级：${r.upgradedSeats.map((i) => seatName(room, i)).join("、")}`
        : null
    ].filter(Boolean).join("<br>");
    resultEl.innerHTML = champLine + kittyLine + `<div class="round-result-lines">${lines}</div>`;
    resultEl.style.display = "block";
  } else {
    resultEl.innerHTML = "";
    resultEl.style.display = "none";
  }
}

function throwPenaltyLines(room) {
  const personal = room.seatPersonalScores || {};
  return Object.entries(personal)
    .map(([idx, value]) => ({ idx: Number(idx), points: Math.abs(Number(value) || 0) }))
    .filter((item) => item.points > 0)
    .sort((a, b) => a.idx - b.idx)
    .map((item) => `${seatName(room, item.idx)}甩牌失败扣${item.points}分`);
}

/* ─── Center "亮主" reveal ───────────────────────────────── */
function renderBidReveal(room) {
  const el = $("#bidReveal");
  if (!el) return;
  const biddingPhases = ["dealing", "auctionReady", "auction", "forcedSuit", "sixTrump"];
  const bid = room.currentBid;
  const cards = bid?.cards || [];

  if (bid && cards.length > 0 && biddingPhases.includes(room.phase)) {
    const who = seatName(room, bid.seat);
    const trumpLabel = bid.noTrump ? "无主" : (bid.trumpSuit ? suitSymbolColored(bid.trumpSuit) : "");
    const cardsHTML = cards.map((c) => playedCardHTML(c)).join("");
    el.innerHTML = `
      <div class="bid-reveal-label">${who} 亮主${trumpLabel ? " · " + trumpLabel : ""}</div>
      <div class="bid-reveal-cards">${cardsHTML}</div>`;
    el.style.display = "flex";

    const sig = `${bid.seat}|${cards.map((c) => c.id).join(",")}`;
    if (sig !== lastBidSig) {
      el.classList.remove("reveal-pop");
      void el.offsetWidth; // force reflow so the animation restarts
      el.classList.add("reveal-pop");
      lastBidSig = sig;
    }
  } else {
    el.innerHTML = "";
    el.style.display = "none";
    lastBidSig = "";
  }
}

/* ─── Controls ───────────────────────────────────────────── */
function renderControls(room) {
  const parts = [];

  const centerAction = $("#centerAction");
  if (room.phase === "lobby") {
    const allSeated = room.seats.every((s) => s.playerId);
    centerAction.innerHTML = `<button data-action="startRound" ${allSeated ? "" : "disabled"} class="primary-action">开始本局</button>`;
  } else {
    centerAction.innerHTML = "";
  }

  if (["dealing", "auctionReady", "auction"].includes(room.phase)) {
    const myIndex = room.viewerSeat;
    const bidResponses = room.bidResponses || {};
    const myResponse = bidResponses[myIndex];
    const hasBid = !!room.currentBid;
    const revealed = (room.revealedKitty || []).length;
    const allRevealed = revealed >= 7;

    parts.push(`<button data-action="bid">亮庄</button>`);

    if (hasBid && !myResponse && room.currentBid.seat !== myIndex) {
      parts.push(`<button data-action="passBid">不抢</button>`);
    }

    if (room.phase === "auctionReady" && !hasBid) {
      parts.push(`<button data-action="startAuction">开始翻底</button>`);
    }

    if (room.phase === "auction" && !hasBid) {
      if (!allRevealed) {
        parts.push(`<button data-action="revealKitty" class="primary-action">翻下一张 (${revealed}/7)</button>`);
      } else {
        parts.push(`<button data-action="forceDealer" class="primary-action">确认强制坐庄</button>`);
      }
    }
  }

  if (room.phase === "sixTrump") {
    const myIndex = room.viewerSeat;
    const bidResponses = room.bidResponses || {};
    const myResponse = bidResponses[myIndex];
    const hasBid = !!room.currentBid;
    if (!myResponse && (!hasBid || room.currentBid.seat !== myIndex)) {
      parts.push(`<button data-action="sixCallTrump" class="primary-action">亮主</button>`);
      parts.push(`<button data-action="sixPassTrump">不亮</button>`);
    } else {
      parts.push(`<span style="color:rgba(255,255,255,.6);font-size:13px">等待其他玩家叫主…</span>`);
    }
  }

  if (room.phase === "forcedSuit") {
    if (room.viewerSeat === room.dealerSeat) {
      parts.push(`
        <select id="forcedSuit">
          <option value="">${room.fixedTeams ? "暂不定主（按无主打）" : `不亮，使用底牌花色（${room.trumpSuit ? suitSymbol(room.trumpSuit) : "无主"}）`}</option>
          <option value="noTrump">亮所选3张王为无主</option>
          <option value="spades">♠ 黑桃</option>
          <option value="hearts">♥ 红桃</option>
          <option value="clubs">♣ 梅花</option>
          <option value="diamonds">♦ 方片</option>
        </select>
        <button data-action="chooseForcedTrump" class="primary-action">确认定主</button>`);
    } else {
      const dealerName = seatName(room, room.dealerSeat);
      parts.push(`<span style="color:rgba(255,255,255,.6);font-size:13px">等待 ${dealerName} 确认主花色…</span>`);
    }
  }

  if (room.phase === "burying" && room.viewerSeat === room.dealerSeat) {
    parts.push(`<button data-action="bury" class="primary-action">扣所选${room.kittyCount || room.kittySize || 7}张</button>`);
  }

  if (room.phase === "friend" && room.viewerSeat === room.dealerSeat) {
    parts.push(friendFormHTML());
  }

  const trickPaused = (room.trickPauseUntil || 0) > Date.now();
  if (room.phase === "playing" && room.viewerSeat === room.turnSeat && !trickPaused) {
    parts.push(`<button data-action="play" class="primary-action">出牌 (${state.selected.size}张)</button>`);
    parts.push(`<button data-action="hint">推荐</button>`);
  } else if (room.phase === "playing" && trickPaused) {
    parts.push(`<span style="color:rgba(255,255,255,.6);font-size:13px">本墩结算中…</span>`);
  }

  if (room.phase === "roundOver") {
    parts.push(`<button data-action="nextRoundLobby" class="primary-action">回到座位准备下一局</button>`);
  }

  $("#contextControls").innerHTML = parts.join("");
  bindControls();
}

function renderTrusteeControls(room) {
  const el = $("#trusteeControls");
  if (!el) return;
  if (room.phase !== "playing" || room.viewerSeat == null) {
    el.innerHTML = "";
    return;
  }
  const trustee = room.seats[room.viewerSeat]?.trustee;
  el.innerHTML = `<button data-action="toggleTrustee" class="trustee-float ${trustee ? "trustee-on" : ""}" title="${trustee ? "取消托管" : "托管"}">${trustee ? "取消托管" : "托管"}</button>`;
  bindControls(el);
}

function friendFormHTML() {
  return `
    <select id="friendOrdinal">
      <option value="1">第1张</option>
      <option value="2">第2张</option>
      <option value="3">第3张</option>
    </select>
    <select id="friendSuit">
      <option value="spades">♠ 黑桃</option>
      <option value="hearts">♥ 红桃</option>
      <option value="clubs">♣ 梅花</option>
      <option value="diamonds">♦ 方片</option>
      <option value="joker">王</option>
    </select>
    <select id="friendRank">
      ${["A","K","Q","J","10","9","8","7","6","5","4","3","2","smallJoker","bigJoker"]
        .map((r) => `<option value="${r}">${rankText(r)}</option>`).join("")}
    </select>
    <button data-action="callFriend" class="primary-action">叫朋友</button>`;
}

function bindControls(root = document) {
  root.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.action;
      if (action === "bid")         send("bid",         { cardIds: [...state.selected] });
      else if (action === "passBid")     send("passBid",     {});
      else if (action === "sixCallTrump") send("sixCallTrump", { cardIds: [...state.selected] });
      else if (action === "sixPassTrump") send("sixPassTrump", {});
      else if (action === "forceDealer") send("forceDealer", {});
      else if (action === "bury")        send("bury",        { cardIds: [...state.selected] });
      else if (action === "play")  send("play", { cardIds: [...state.selected] });
      else if (action === "hint")  send("hint", {});
      else if (action === "toggleTrustee") {
        const mySeat = state.room?.seats.find((s) => s.isYou);
        send("setTrustee", { on: !(mySeat && mySeat.trustee) });
      }
      else if (action === "callFriend") {
        send("callFriend", {
          ordinal: Number($("#friendOrdinal").value),
          suit:    $("#friendSuit").value,
          rank:    $("#friendRank").value
        });
      } else if (action === "chooseForcedTrump") {
        const val = $("#forcedSuit").value;
        send("chooseForcedTrump", {
          suit:    val === "noTrump" ? null : (val || null),
          noTrump: val === "noTrump",
          cardIds: [...state.selected]
        });
      } else {
        send(action);
      }
    });
  });
}

/* ─── Hand (fanned, overlapping) ────────────────────────── */
function renderHand(room) {
  const you = room.seats.find((s) => s.isYou);
  const hand = you?.hand || [];

  $("#selectionInfo").textContent = state.selected.size > 0 ? `已选 ${state.selected.size} 张` : "";

  // Reset the deal-in tracker whenever we're not actively dealing, so the next
  // round's deal animates fresh (and normal play never animates).
  if (room.phase !== "dealing") dealtCardIds.clear();

  const container = $("#hand");
  container.innerHTML = "";
  if (hand.length === 0) {
    // No hand (e.g. lobby): collapse the area so action buttons sit at the
    // bottom instead of being pushed up over a seat.
    container.style.height = "0";
    return;
  }

  const isPortrait = window.innerHeight > window.innerWidth;
  const containerWidth = container.clientWidth || (window.innerWidth - 20);
  const cardW = Math.round(52 * UI);

  // Portrait narrow screens: split into 2 rows
  if (isPortrait && window.innerWidth < 500 && hand.length > 8) {
    const half = Math.ceil(hand.length / 2);
    const row1 = hand.slice(0, half);
    const row2 = hand.slice(half);
    container.style.height = `${Math.round(160 * UI)}px`;
    renderHandRow(container, row1, containerWidth, cardW, 78);  // bottom row
    renderHandRow(container, row2, containerWidth, cardW, 2);   // top row
  } else {
    container.style.height = `${Math.round(86 * UI)}px`;
    renderHandRow(container, hand, containerWidth, cardW, 2);
  }
}

function renderHandRow(container, hand, containerWidth, cardW, bottomOffset) {
  const maxOffset = Math.min(Math.round(38 * UI), Math.floor((containerWidth - cardW) / Math.max(hand.length - 1, 1)));
  const totalWidth = cardW + (hand.length - 1) * maxOffset;
  const startX = Math.max(0, (containerWidth - totalWidth) / 2);

  const dealing = state.room?.phase === "dealing";
  hand.forEach((card, i) => {
    const el = document.createElement("button");
    // Only animate cards that are newly dealt this round → no whole-hand flicker.
    const isNewDealt = dealing && !dealtCardIds.has(card.id);
    if (dealing) dealtCardIds.add(card.id);
    el.className = `card ${isRed(card) ? "red" : (card.suit === "joker" ? "joker" : "black")} ${card.rank === "bigJoker" ? "big-joker" : ""} ${isNewDealt ? "dealing-in" : ""}`;
    el.dataset.card = card.id;
    el.title = card.label;

    const selected = state.selected.has(card.id);
    el.style.left   = `${startX + i * maxOffset}px`;
    el.style.bottom = `${bottomOffset}px`;
    el.style.zIndex = selected ? 50 : i + 1;
    if (selected) el.classList.add("selected");

    el.innerHTML = cardFaceHTML(card);
    el.addEventListener("click", () => {
      if (state.selected.has(card.id)) state.selected.delete(card.id);
      else state.selected.add(card.id);
      renderHand(state.room);
      renderControls(state.room);
    });
    container.appendChild(el);
  });
}

/* ─── Card Face HTML ─────────────────────────────────────── */
function cardFaceHTML(card) {
  if (card.rank === "bigJoker") {
    return `
      <div class="card-corner">
        <div class="card-rank" style="font-size:9px;color:#b8860b">JOKER</div>
      </div>
      <div class="card-center" style="font-size:13px;font-weight:900;color:#b8860b">大王</div>
      <div class="card-corner bottom">
        <div class="card-rank" style="font-size:9px;color:#b8860b">JOKER</div>
      </div>`;
  }
  if (card.rank === "smallJoker") {
    return `
      <div class="card-corner">
        <div class="card-rank" style="font-size:9px;color:#5c3a00">Joker</div>
      </div>
      <div class="card-center" style="font-size:13px;font-weight:900;color:#5c3a00">小王</div>
      <div class="card-corner bottom">
        <div class="card-rank" style="font-size:9px;color:#5c3a00">Joker</div>
      </div>`;
  }
  return `
    <div class="card-corner">
      <div class="card-rank">${rankText(card.rank)}</div>
      <div class="card-suit-sm">${suitSymbol(card.suit)}</div>
    </div>
    <div class="card-center">${suitSymbol(card.suit)}</div>
    <div class="card-corner bottom">
      <div class="card-rank">${rankText(card.rank)}</div>
      <div class="card-suit-sm">${suitSymbol(card.suit)}</div>
    </div>`;
}

/* ─── Log ────────────────────────────────────────────────── */
function renderLog(room) {
  renderPreviousTrick(room, $("#log"));
}

// 抽屉：记录 / 战绩 互斥展开。
function openDrawer(id, render) {
  for (const p of ["#logPanel", "#standingsPanel"]) {
    if (p !== id) $(p).classList.remove("open");
  }
  const panel = $(id);
  panel.classList.toggle("open");
  if (panel.classList.contains("open") && render) render(state.room);
}
$("#logToggle").addEventListener("click", () => openDrawer("#logPanel", renderLog));
$("#standingsToggle").addEventListener("click", () => openDrawer("#standingsPanel", renderStandings));

// 上一墩回看：只展示最近完成的一墩，避免右下角记录越积越长。
function renderPreviousTrick(room, el) {
  if (!el) return;
  const info = room?.lastTrickWin;
  const plays = room?.lastTrick || [];
  if (!info || !plays.length) { el.innerHTML = `<div class="history-empty">还没有上一墩记录</div>`; return; }
  const rows = plays.map((p) => {
    const cards = p.cards.map((c) => `<span class="hcard ${isRed(c) ? "red" : "black"}">${cardShortLabel(c)}</span>`).join(" ");
    return `<div class="history-play${p.seat === info.winner ? " win" : ""}"><span class="hseat">${seatName(room, p.seat)}</span><span>${cards}</span></div>`;
  }).join("");
  el.innerHTML = `<div class="history-trick"><div class="history-head">第 ${info.seq} 墩 · ${seatName(room, info.winner)} +${info.points}</div>${rows}</div>`;
}

// 战绩：各家当前等级 + 历次对局结果（数据来自 publicState.matchLog）。
function renderStandings(room) {
  const el = $("#standings");
  if (!el) return;
  const levels = room.seats.filter((s) => s.playerId).map((s) =>
    `<div class="sd-lvrow"><span class="sd-seat">${seatName(room, s.index)}</span><span class="sd-lv">打 ${escapeHtml(s.level || "-")}</span></div>`).join("");
  const log = room.matchLog || [];
  const rows = log.length
    ? log.slice().reverse().map((m) => {
        const champ = m.champion ? ` · 🏆${m.champion === "dealer" ? "庄家队" : "闲家队"}夺冠` : "";
        return `<div class="sd-row"><span class="sd-rnd">第${m.round}局</span><span>闲家 ${m.attackers}</span><span class="sd-res">${escapeHtml(m.label)}${champ}</span></div>`;
      }).join("")
    : `<div class="history-empty">还没有完成的对局</div>`;
  el.innerHTML = `<div class="sd-head">各家等级</div>${levels}<div class="sd-head">历史对局</div>${rows}`;
}

// 通关庆祝：检测 champion 这一局首次出现，撒一阵金色彩屑。
let lastChampRound = null;
function maybeAnimateChampion(room) {
  const r = room.lastResult;
  if (!r || !r.champion || room.phase !== "roundOver") return;
  if (room.round === lastChampRound) return;
  lastChampRound = room.round;
  for (let i = 0; i < 18; i++) {
    const e = document.createElement("div");
    e.className = "champ-confetti";
    e.textContent = ["🎉", "🏆", "✨", "🎊", "⭐"][i % 5];
    e.style.left = `${Math.random() * 100}vw`;
    e.style.top = "-40px";
    document.body.appendChild(e);
    e.animate([
      { transform: "translateY(0) rotate(0deg)", opacity: 1 },
      { transform: `translateY(105vh) rotate(${(Math.random() * 720 - 360) | 0}deg)`, opacity: .85 }
    ], { duration: 1800 + Math.random() * 1200, easing: "cubic-bezier(.3,.6,.5,1)", delay: Math.random() * 400 }).onfinish = () => e.remove();
  }
}

// Re-render on orientation change so layout updates immediately
window.addEventListener("orientationchange", () => {
  setTimeout(() => { if (state.room) render(); }, 150);
});
window.addEventListener("resize", () => {
  if (state.room) renderHand(state.room);
  updatePingStatus();
});

// ─── Auto-reconnect after the app is backgrounded / loses the socket ──────────
// On mobile, switching away can suspend or kill the WebSocket; on return the UI
// looks frozen. Re-open the connection (the server re-seats us via our playerId).
function reconnectIfNeeded() {
  if (!state.room?.code) return;
  const ws = state.ws;
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  connectAndJoin(state.room.code, state.nickname);
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    reconnectIfNeeded();
    updatePingStatus();
  }
});
window.addEventListener("pageshow", reconnectIfNeeded);
window.addEventListener("focus", reconnectIfNeeded);
window.addEventListener("online", reconnectIfNeeded);

// Fullscreen toggle (works on Android; Safari requires Add to Home Screen)
const fullscreenBtn = document.getElementById("fullscreenBtn");
if (fullscreenBtn) {
  fullscreenBtn.addEventListener("click", () => {
    const el = document.documentElement;
    if (!document.fullscreenElement) {
      (el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen
        || (() => {})).call(el);
      fullscreenBtn.textContent = "✕";
    } else {
      (document.exitFullscreen || document.webkitExitFullscreen
        || (() => {})).call(document);
      fullscreenBtn.textContent = "⛶";
    }
  });
  document.addEventListener("fullscreenchange", () => {
    fullscreenBtn.textContent = document.fullscreenElement ? "✕" : "⛶";
  });
}

/* ─── Audio: unlock on first gesture + settings popover ────── */
// Browser autoplay policy: the AudioContext can only start from a user gesture.
window.addEventListener("pointerdown", () => unlock(), { once: true });
window.addEventListener("keydown", () => unlock(), { once: true });
const audioBtn = document.getElementById("audioBtn");
const audioPanel = document.getElementById("audioPanel");
const musicChk = document.getElementById("musicChk");
const voiceChk = document.getElementById("voiceChk");
const musicVolRange = document.getElementById("musicVolRange");
const fxVolRange = document.getElementById("fxVolRange");
const trackSel = document.getElementById("trackSel");
function refreshAudioBtn() {
  const s = audioState();
  if (audioBtn) audioBtn.classList.toggle("audio-off", !s.musicOn && !s.voiceOn);
}
{
  const s = audioState();
  if (musicChk) musicChk.checked = s.musicOn;
  if (voiceChk) voiceChk.checked = s.voiceOn;
  if (musicVolRange) musicVolRange.value = String(Math.round(s.musicVol * 100));
  if (fxVolRange) fxVolRange.value = String(Math.round(s.fxVol * 100));
  if (trackSel) {
    trackSel.innerHTML = musicTracks().map((t) => `<option value="${t.id}">${t.name}</option>`).join("");
    trackSel.value = currentTrackId();
  }
  refreshAudioBtn();
}
trackSel?.addEventListener("change", () => { unlock(); selectTrack(trackSel.value); });
audioBtn?.addEventListener("click", (e) => { e.stopPropagation(); unlock(); audioPanel?.classList.toggle("hidden"); });
document.addEventListener("click", (e) => {
  if (audioPanel && !audioPanel.classList.contains("hidden") && !e.target.closest(".audio-menu")) {
    audioPanel.classList.add("hidden");
  }
});
musicChk?.addEventListener("change", () => { unlock(); musicChk.checked = toggleMusic(); refreshAudioBtn(); });
voiceChk?.addEventListener("change", () => { unlock(); const on = toggleVoice(); voiceChk.checked = on; if (on) speak("语音已开"); refreshAudioBtn(); });
musicVolRange?.addEventListener("input", () => { unlock(); setMusicVol(Number(musicVolRange.value) / 100); });
fxVolRange?.addEventListener("input", () => { unlock(); setFxVol(Number(fxVolRange.value) / 100); });

// Exit the current room and return to the join screen.
function exitRoom() {
  const room = state.room;
  if (room && room.phase !== "lobby") {
    if (!confirm("游戏正在进行中，确定要退出房间吗？")) return;
  }
  // Free our seat if we're still in the lobby so others can use it.
  if (room && room.phase === "lobby" && state.ws && state.ws.readyState === WebSocket.OPEN) {
    const you = room.seats.find((s) => s.isYou);
    if (you) send("leaveSeat");
  }
  // Stop auto-reconnect from pulling us back in.
  localStorage.removeItem("szp.roomCode");
  state.room = null;
  try { state.ws?.close(); } catch (_) {}
  state.ws = null;
  state.selected.clear();
  document.querySelector('[data-view="game"]').classList.add("hidden");
  document.querySelector('[data-view="join"]').classList.remove("hidden");
  $("#roomCode").value = "";
}

const exitRoomBtn = document.getElementById("exitRoomBtn");
if (exitRoomBtn) exitRoomBtn.addEventListener("click", exitRoom);

let kickDialogEl = null;
function openKickDialog() {
  const room = state.room;
  if (!room) return;
  const you = room.seats.find((s) => s.isYou);
  if (!you) { showError("请先入座"); return; }
  closeKickDialog();
  const targets = room.seats.filter((s) => s.playerId && !s.isYou);
  const overlay = document.createElement("div");
  overlay.className = "kick-dialog-backdrop";
  overlay.innerHTML = `
    <div class="kick-dialog" role="dialog" aria-modal="true">
      <div class="kick-dialog-title">发起踢人投票</div>
      <div class="kick-dialog-list">
        ${targets.length ? targets.map((s) =>
          `<button class="kick-target" data-seat="${s.index}">${escapeHtml(s.nickname || `座位${s.index + 1}`)}</button>`
        ).join("") : `<div class="kick-empty">暂无可选择玩家</div>`}
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeKickDialog();
  });
  overlay.querySelectorAll("[data-seat]").forEach((btn) => {
    btn.addEventListener("click", () => {
      send("kickStart", { targetSeat: Number(btn.dataset.seat) });
      closeKickDialog();
    });
  });
  kickDialogEl = overlay;
}
function closeKickDialog() {
  if (kickDialogEl) { kickDialogEl.remove(); kickDialogEl = null; }
}

function showKickVotePrompt(vote) {
  if (!vote?.voteId) return;
  const ok = confirm(`${vote.initiatorName} 玩家发起对 ${vote.targetName} 的踢人，是否同意？`);
  if (ok) send("kickAgree", { voteId: vote.voteId });
}

function handleKicked(payload = {}) {
  alert(payload.message || "你已被移出房间。");
  localStorage.removeItem("szp.roomCode");
  state.room = null;
  state.selected.clear();
  try { state.ws?.close(); } catch (_) {}
  state.ws = null;
  document.querySelector('[data-view="game"]').classList.add("hidden");
  document.querySelector('[data-view="join"]').classList.remove("hidden");
}

$("#kickBtn")?.addEventListener("click", openKickDialog);

/* ─── Error ──────────────────────────────────────────────── */
function showError(msg) {
  const box = $("#errorBox");
  box.textContent = msg;
  setTimeout(() => { if (box.textContent === msg) box.textContent = ""; }, 3500);
}

/* ─── Helpers ────────────────────────────────────────────── */
function phaseText(phase) {
  return {
    lobby:       "等待入座",
    dealing:     "摸牌抢庄",
    auctionReady:"等待翻底",
    auction:     "翻底拍卖",
    forcedSuit:  "强制定主",
    sixTrump:    "叫主",
    burying:     "庄家扣底",
    friend:      "叫朋友",
    playing:     "出牌中",
    roundOver:   "本局结束"
  }[phase] || phase;
}

// 返回值会直接插入 innerHTML（轮次提示/结算/亮庄日志等），故在此统一 HTML 转义，
// 防止玩家用 <img onerror=...> 之类的昵称注入脚本（存储型 XSS）。
function seatName(room, index) {
  return escapeHtml(room.seats[index]?.nickname || `座位${index + 1}`);
}

function suitSymbol(suit) {
  return { spades: "♠", hearts: "♥", clubs: "♣", diamonds: "♦" }[suit] || "";
}

function suitEmoji(suit) {
  return { spades: "♠️", hearts: "♥️", clubs: "♣️", diamonds: "♦️" }[suit] || "";
}

// 带颜色的花色符号（红桃/方片红、黑桃/梅花黑）。用白底小块保证在深色背景上也清晰可见。
function suitSymbolColored(suit) {
  const sym = suitSymbol(suit);
  if (!sym) return "";
  const red = suit === "hearts" || suit === "diamonds";
  return `<span class="suit-pip ${red ? "red" : "black"}">${sym}</span>`;
}

function isRed(card) {
  return card.suit === "hearts" || card.suit === "diamonds";
}

function cardShortLabel(card) {
  if (!card) return "";
  if (card.suit === "joker") return escapeHtml(rankText(card.rank));
  return `${suitEmoji(card.suit)}${escapeHtml(rankText(card.rank))}`;
}

function rankText(rank) {
  if (rank === "smallJoker") return "小王";
  if (rank === "bigJoker")   return "大王";
  return rank;
}
