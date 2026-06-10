// Self-contained game audio — no external files (no copyright):
//   • procedural background music (Web Audio, gentle pentatonic loop)
//   • Chinese voice callouts via the browser SpeechSynthesis (TTS): 大你 / 管上 /
//     杀 / 亮主 / 甩牌 …  (like 欢乐斗地主's spoken lines, synthesized on-device)
//   • short synth sound effects for card plays / trick wins
// Toggles persist in localStorage. Audio must be unlocked by a user gesture
// (browser autoplay policy) — call unlock() from a click handler.

let ctx = null;
let master = null;
let musicGain = null;
let musicTimer = null;
let started = false;
let musicOn = localStorage.getItem("szp.music") !== "0"; // default on
let voiceOn = localStorage.getItem("szp.voice") !== "0"; // default on
// Separate volumes: music vs voice/effects (so you can balance them).
let musicVol = Math.min(1, Math.max(0, parseFloat(localStorage.getItem("szp.musicVol") ?? "0.5")));
let fxVol = Math.min(1, Math.max(0, parseFloat(localStorage.getItem("szp.fxVol") ?? "0.9")));

function ensureCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();           // drives synth sound-effects → fxVol
    master.gain.value = fxVol;
    master.connect(ctx.destination);
    musicGain = ctx.createGain();        // drives the synth music fallback → musicVol
    musicGain.gain.value = 0.0;
    musicGain.connect(ctx.destination);
  }
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

// ── procedural background music ─────────────────────────────────────────────
// A slow C-major-pentatonic arpeggio with a soft sustained fifth underneath,
// looping every 8 beats. Tasteful and low so it sits behind play.
const PENTA = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33]; // C D E G A C5 D5
const MELODY = [0, 2, 4, 3, 5, 4, 2, 3, 0, 2, 3, 5, 6, 5, 4, 2]; // indices into PENTA
let padOsc = [];
let melodyStep = 0;

function pluck(freq, when, dur = 0.5, gain = 0.18, type = "triangle") {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(gain, when + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  o.connect(g); g.connect(musicGain);
  o.start(when); o.stop(when + dur + 0.05);
}

// File-based BGM with a track picker. The default track (6199) has a 32s intro
// then the in-game loop: we play the [0,32s) region on the opening/lobby and loop
// the [32s,end) region once a hand starts. Other tracks just loop whole. Selection
// persists. Falls back to the synth loop only if the bundled /bgm.mp3 fails.
const MUSIC = [
  { id: "default", name: "默认（开场+牌局）", src: "/bgm.mp3", splitAt: 32 },
  { id: "swing",   name: "摇摆爵士",          src: "https://assets.mixkit.co/music/526/526.mp3" },
  { id: "jazz",    name: "轻松爵士",          src: "https://assets.mixkit.co/music/528/528.mp3" },
  { id: "world",   name: "游戏节拍",          src: "https://assets.mixkit.co/music/466/466.mp3" }
];
let trackId = localStorage.getItem("szp.track") || "default";
let musicPhase = "lobby";          // "lobby" (opening) | "game"
let bgmEl = null;                  // HTMLAudioElement | null
let bgmFailed = false;             // bundled file failed → use synth
let regionStart = 0, regionEnd = Infinity;
let gapTimer = null;
let loopGapSec = Math.max(0, parseFloat(localStorage.getItem("szp.loopgap") ?? "3"));
const curTrack = () => MUSIC.find((t) => t.id === trackId) || MUSIC[0];

function clearLoopGap() { if (gapTimer) { clearTimeout(gapTimer); gapTimer = null; } }
function applyRegion() {
  const t = curTrack();
  const dur = (bgmEl && bgmEl.duration) || Infinity;
  if (t.splitAt && musicPhase === "lobby") { regionStart = 0; regionEnd = t.splitAt; } // 开场段 [0,32)
  else if (t.splitAt) { regionStart = t.splitAt; regionEnd = dur; }                     // 牌局段 [32,末)
  else { regionStart = 0; regionEnd = dur; }                                            // 非分段曲整段
}
// Opening (lobby) loops with a short breath-gap; in-game loops seamlessly.
function loopBack() {
  if (gapTimer || !bgmEl) return;
  if (musicPhase === "lobby" && curTrack().splitAt && loopGapSec > 0) {
    try { bgmEl.pause(); } catch (_) {}
    gapTimer = setTimeout(() => { gapTimer = null; if (!bgmEl || !started || !musicOn || trackId === "off") return; bgmEl.currentTime = regionStart; bgmEl.play().catch(() => {}); }, loopGapSec * 1000);
  } else { bgmEl.currentTime = regionStart; }
}

function startMusic() {
  if (!ensureCtx() || trackId === "off") return;
  if (bgmFailed) { startSynthMusic(); return; }
  if (!bgmEl) {
    bgmEl = new Audio(curTrack().src);
    bgmEl.loop = false;
    bgmEl.volume = Math.min(1, musicVol);
    bgmEl.addEventListener("loadedmetadata", () => { applyRegion(); if (bgmEl.currentTime < regionStart || bgmEl.currentTime >= regionEnd) bgmEl.currentTime = regionStart; });
    bgmEl.addEventListener("timeupdate", () => { if (!gapTimer && regionEnd !== Infinity && bgmEl.currentTime >= regionEnd - 0.06) loopBack(); });
    bgmEl.addEventListener("ended", () => { if (!gapTimer) loopBack(); });
    bgmEl.addEventListener("error", () => { if (curTrack().id === "default") { bgmFailed = true; bgmEl = null; startSynthMusic(); } });
  }
  applyRegion();
  if (bgmEl.currentTime < regionStart || (regionEnd !== Infinity && bgmEl.currentTime >= regionEnd)) bgmEl.currentTime = regionStart;
  bgmEl.volume = Math.min(1, musicVol);
  bgmEl.play().catch(() => {});
}
function stopMusic() {
  clearLoopGap();
  if (bgmEl) { try { bgmEl.pause(); } catch (_) {} }
  stopSynthMusic();
}
// 大厅放开场段循环；进房开打切到牌局段（带 0.4s 淡入淡出，切换不突兀）。
export function setMusicPhase(phase) {
  const p = phase === "lobby" ? "lobby" : "game";
  if (p === musicPhase) return;
  musicPhase = p;
  clearLoopGap();
  applyRegion();
  if (!started || !musicOn || !bgmEl || !curTrack().splitAt) return;
  const tgt = Math.min(1, musicVol);
  const fadeOut = setInterval(() => {
    if (!bgmEl) { clearInterval(fadeOut); return; }
    if (bgmEl.volume > 0.08) { bgmEl.volume = Math.max(0, bgmEl.volume - 0.12); return; }
    clearInterval(fadeOut);
    bgmEl.currentTime = regionStart; bgmEl.volume = 0;
    bgmEl.play().catch(() => {});
    const fadeIn = setInterval(() => { if (!bgmEl) { clearInterval(fadeIn); return; } bgmEl.volume = Math.min(tgt, bgmEl.volume + 0.12); if (bgmEl.volume >= tgt) clearInterval(fadeIn); }, 45);
  }, 45);
}
export function selectTrack(id) {
  trackId = id;
  localStorage.setItem("szp.track", id);
  bgmFailed = false;
  clearLoopGap();
  if (bgmEl) { try { bgmEl.pause(); } catch (_) {} bgmEl = null; }
  stopSynthMusic();
  if (started && musicOn && id !== "off") startMusic();
  return id;
}
export const musicTracks = () => MUSIC.map((t) => ({ id: t.id, name: t.name }));
export const currentTrackId = () => trackId;

function startSynthMusic() {
  if (!ensureCtx() || musicTimer) return;
  musicGain.gain.cancelScheduledValues(ctx.currentTime);
  musicGain.gain.linearRampToValueAtTime(0.5 * musicVol, ctx.currentTime + 1.5);
  // sustained soft pad: root + fifth, two slightly detuned triangle oscillators
  padOsc = [];
  for (const f of [130.81, 196.0]) { // C3, G3
    for (const det of [-2, 2]) {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = "sine"; o.frequency.value = f; o.detune.value = det;
      g.gain.value = 0.05; o.connect(g); g.connect(musicGain); o.start();
      padOsc.push(o, g);
    }
  }
  const beat = 0.42; // seconds per step
  const tick = () => {
    if (!musicTimer) return;
    const idx = MELODY[melodyStep % MELODY.length];
    pluck(PENTA[idx], ctx.currentTime + 0.02, 0.55, 0.16, "triangle");
    if (melodyStep % 4 === 0) pluck(PENTA[idx] / 2, ctx.currentTime + 0.02, 0.9, 0.10, "sine"); // bass
    melodyStep++;
  };
  tick();
  musicTimer = setInterval(tick, beat * 1000);
}

function stopSynthMusic() {
  if (musicTimer) { clearInterval(musicTimer); musicTimer = null; }
  if (!ctx) return;
  musicGain.gain.cancelScheduledValues(ctx.currentTime);
  musicGain.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 0.6);
  const old = padOsc; padOsc = [];
  setTimeout(() => { for (const n of old) { try { n.stop && n.stop(); } catch (_) {} } }, 800);
}

// ── sound effects ───────────────────────────────────────────────────────────
// Prefer a downloaded clip public/sfx/<name>.mp3 (real, polished); fall back to
// the synth below if the file is absent.
const sfxClips = {};
export function sfx(name) {
  if (sfxClips[name] !== "missing") {
    let c = sfxClips[name];
    if (!c) { c = new Audio(`/sfx/${name}.wav`); sfxClips[name] = c; }
    try {
      c.volume = Math.min(1, fxVol);
      c.currentTime = 0;
      const p = c.play();
      if (p && p.catch) p.catch(() => { sfxClips[name] = "missing"; synthSfx(name); });
      return;
    } catch (_) { sfxClips[name] = "missing"; }
  }
  synthSfx(name);
}
function synthSfx(name) {
  if (!ensureCtx()) return;
  const t = ctx.currentTime;
  if (name === "play") {
    pluckFx(330, t, 0.12, 0.22, "square");
  } else if (name === "win") {
    [523.25, 659.25, 783.99].forEach((f, i) => pluckFx(f, t + i * 0.08, 0.25, 0.2, "triangle"));
  } else if (name === "kill") {
    pluckFx(160, t, 0.18, 0.3, "sawtooth");
    pluckFx(120, t + 0.06, 0.22, 0.28, "sawtooth");
  } else if (name === "deal") {
    pluckFx(800, t, 0.05, 0.12, "square");
  } else if (name === "tractor") {
    // 拖拉机=连对：火车汽笛 + 哐当哐当（可被 /sfx/tractor.wav 覆盖）
    [349.23, 466.16].forEach((f) => {            // 双音汽笛 "呜——"
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = "sawtooth"; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.16, t + 0.05);
      g.gain.setValueAtTime(0.16, t + 0.32); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.48);
      o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.5);
    });
    for (let i = 0; i < 6; i++) {                 // 由慢到快的车轮声
      const when = t + 0.5 + i * (0.16 - i * 0.008);
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = "sine"; o.frequency.setValueAtTime(95, when); o.frequency.exponentialRampToValueAtTime(52, when + 0.07);
      g.gain.setValueAtTime(0.0001, when); g.gain.exponentialRampToValueAtTime(0.3, when + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, when + 0.1);
      o.connect(g); g.connect(master); o.start(when); o.stop(when + 0.12);
      noiseBurst(when + 0.005, 0.08, 0.14, 1400); // 蒸汽 "嚓"
    }
  }
}
let _noiseBuf = null;
function noiseBurst(when, dur, gain, cutoff) {
  if (!_noiseBuf) { _noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.5), ctx.sampleRate); const d = _noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
  const src = ctx.createBufferSource(); src.buffer = _noiseBuf;
  const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = cutoff;
  const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, when); g.gain.exponentialRampToValueAtTime(gain, when + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  src.connect(f); f.connect(g); g.connect(master); src.start(when); src.stop(when + dur + 0.02);
}
function pluckFx(freq, when, dur, gain, type) {
  const o = ctx.createOscillator(); const g = ctx.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(gain, when + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  o.connect(g); g.connect(master);
  o.start(when); o.stop(when + dur + 0.03);
}

// ── voice (TTS) ─────────────────────────────────────────────────────────────
// Prefer the most natural Chinese voice the device offers: high-quality neural /
// Siri / premium voices first, then the better named ones.
const PREFERRED = [
  /neural|online|premium|enhanced/i, /Siri/i,
  /Tingting|婷婷/i, /Meijia|美佳/i, /Yaoyao/i, /Huihui|慧慧/i, /Kangkang/i,
  /Google.*(普通话|中文|Chinese)/i
];
let zhVoice = null;
function pickVoice() {
  if (!("speechSynthesis" in window)) return;
  const zh = speechSynthesis.getVoices().filter((v) => /zh/i.test(v.lang) || /Chinese|普通话|中文/i.test(v.name));
  for (const re of PREFERRED) { const m = zh.find((v) => re.test(v.name)); if (m) { zhVoice = m; return; } }
  zhVoice = zh.find((v) => /zh[-_]?CN/i.test(v.lang)) || zh[0] || null;
}
if ("speechSynthesis" in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }

// Optional recorded clips for real intonation: drop public/voice/<词>.mp3
// (例如 大你.mp3、吊主.mp3)。有则播片，无则退回 TTS（短词偏平）。
const clips = {};
const clipKey = (t) => t.replace(/[！!。．.\s，,、？?]/g, "");
function ttsSpeak(text) {
  if (!("speechSynthesis" in window)) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "zh-CN";
    u.rate = 1.05 + Math.random() * 0.15;  // 1.05–1.20，干脆利落
    u.pitch = 1.0 + Math.random() * 0.25;  // 1.0–1.25，自然又带点精神（过高会发尖）
    u.volume = Math.min(1, fxVol + 0.1);
    if (zhVoice) u.voice = zhVoice;
    speechSynthesis.speak(u);
  } catch (_) { /* ignore */ }
}
export function speak(text) {
  if (!voiceOn) return;
  const key = clipKey(text);
  if (clips[key] === "missing") { ttsSpeak(text); return; }
  let c = clips[key];
  if (!c) { c = new Audio(`/voice/${encodeURIComponent(key)}.wav`); clips[key] = c; } // ChatTTS 录音
  try {
    c.volume = Math.min(1, fxVol + 0.1);
    c.currentTime = 0;
    const p = c.play();
    if (p && p.catch) p.catch(() => { clips[key] = "missing"; ttsSpeak(text); }); // 无此片→TTS
  } catch (_) { clips[key] = "missing"; ttsSpeak(text); }
}
export const pick = (arr) => arr[(Math.random() * arr.length) | 0];

// ── control ─────────────────────────────────────────────────────────────────
export function unlock() {
  if (started) return;
  started = true;
  if (!ensureCtx()) return;
  if (musicOn) startMusic();
  pickVoice();
}
export function toggleMusic() {
  musicOn = !musicOn;
  localStorage.setItem("szp.music", musicOn ? "1" : "0");
  if (started) { musicOn ? startMusic() : stopMusic(); }
  return musicOn;
}
export function toggleVoice() {
  voiceOn = !voiceOn;
  localStorage.setItem("szp.voice", voiceOn ? "1" : "0");
  if (!voiceOn && "speechSynthesis" in window) speechSynthesis.cancel();
  return voiceOn;
}
export function setMusicVol(v) {
  musicVol = Math.min(1, Math.max(0, v));
  localStorage.setItem("szp.musicVol", String(musicVol));
  if (bgmEl) bgmEl.volume = Math.min(1, musicVol);
  return musicVol;
}
export function setFxVol(v) {
  fxVol = Math.min(1, Math.max(0, v));
  localStorage.setItem("szp.fxVol", String(fxVol));
  if (master && ctx) master.gain.setTargetAtTime(fxVol, ctx.currentTime, 0.03);
  return fxVol;
}
export const audioState = () => ({ musicOn, voiceOn, musicVol, fxVol, started });
