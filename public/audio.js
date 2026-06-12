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
let musicOn = localStorage.getItem("szp.music") === "1"; // default off; players opt in
let voiceOn = localStorage.getItem("szp.voice") === "1"; // default off; players opt in
// Separate volumes: music vs voice/effects (so you can balance them).
let musicVol = Math.min(1, Math.max(0, parseFloat(localStorage.getItem("szp.musicVol") ?? "0.2")));
let fxVol = Math.min(1, Math.max(0, parseFloat(localStorage.getItem("szp.fxVol") ?? "0.8")));

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
  { id: "one-summers-day", name: "One Summer's Day", src: "/One%20Summer%27S%20Day.mp3" },
  { id: "kiss-the-rain",   name: "Kiss the Rain",    src: "/kiss%20the%20rain.mp3" },
  { id: "huan-qin",        name: "欢沁",              src: "/%E6%AC%A2%E6%B2%81.mp3" }
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
function isTouchDevice() {
  return (typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches) ||
    (typeof navigator !== "undefined" && navigator.maxTouchPoints > 0);
}
function sfxVolume(name) {
  return name === "play" && isTouchDevice() ? fxVol * 0.16 : fxVol;
}
export function sfx(name) {
  if (!voiceOn || fxVol <= 0) return;
  if (sfxClips[name] !== "missing") {
    let c = sfxClips[name];
    if (!c) { c = new Audio(`/sfx/${name}.wav`); sfxClips[name] = c; }
    try {
      c.volume = Math.min(1, sfxVolume(name));
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
    pluckFx(330, t, 0.12, isTouchDevice() ? 0.035 : 0.22, "square");
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
let zhFemaleVoice = null;
let zhMaleVoice = null;
function pickVoice() {
  if (!("speechSynthesis" in window)) return;
  const zh = speechSynthesis.getVoices().filter((v) => /zh/i.test(v.lang) || /Chinese|普通话|中文/i.test(v.name));
  zhVoice = null;
  for (const re of PREFERRED) {
    const m = zh.find((v) => re.test(v.name));
    if (m) { zhVoice = m; break; }
  }
  zhVoice = zhVoice || zh.find((v) => /zh[-_]?CN/i.test(v.lang)) || zh[0] || null;
  zhFemaleVoice = zh.find((v) => /female|woman|girl|Tingting|婷婷|Meijia|美佳|Yaoyao|Huihui|慧慧|Xiaoxiao|Xiaoyi|晓晓|晓伊/i.test(v.name)) || zhVoice;
  zhMaleVoice = zh.find((v) => /male|man|boy|Kangkang|康康|Yunxi|Yunjian|云希|云健|Sinji|Tianyi/i.test(v.name)) || zhVoice;
}
if ("speechSynthesis" in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }

// Optional recorded clips for real intonation: drop public/voice/<key>.wav.
// Cue keys are defined in app.js, e.g. tractor1.wav, kill1.wav, overtake-dani1.wav.
const clips = {};
const voiceBuffers = {};
const clipKey = (t) => t.replace(/[！!。．.\s，,、？?]/g, "");
function decodeAudioDataCompat(arrayBuffer) {
  return new Promise((resolve, reject) => {
    const result = ctx.decodeAudioData(arrayBuffer, resolve, reject);
    if (result && result.then) result.then(resolve, reject);
  });
}
async function playBufferedVoiceByKey(key) {
  if (!ensureCtx()) return false;
  try {
    if (!voiceBuffers[key]) {
      voiceBuffers[key] = fetch(`/voice/${encodeURIComponent(key)}.wav?v=3`)
        .then((res) => {
          if (!res.ok) throw new Error("missing voice clip");
          return res.arrayBuffer();
        })
        .then((buf) => decodeAudioDataCompat(buf));
    }
    const buffer = await voiceBuffers[key];
    if (!voiceOn || fxVol <= 0 || !buffer) return false;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(master);
    src.start(ctx.currentTime);
    return true;
  } catch (_) {
    voiceBuffers[key] = null;
    return false;
  }
}
function playClipByKey(keys, text, options, index = 0) {
  if (index >= keys.length) return false;
  const key = keys[index];
  if (clips[key] === "missing") return playClipByKey(keys, text, options, index + 1);
  if (isTouchDevice()) {
    playBufferedVoiceByKey(key).then((ok) => {
      if (!ok && !playClipByKey(keys, text, options, index + 1)) ttsSpeak(text, options);
    });
    return true;
  }
  let c = clips[key];
  if (!c) { c = new Audio(`/voice/${encodeURIComponent(key)}.wav?v=3`); clips[key] = c; }
  try {
    c.volume = Math.min(1, fxVol);
    c.currentTime = 0;
    const p = c.play();
    if (p && p.catch) p.catch(() => {
      clips[key] = "missing";
      if (!playClipByKey(keys, text, options, index + 1)) ttsSpeak(text, options);
    });
    return true;
  } catch (_) {
    clips[key] = "missing";
    return playClipByKey(keys, text, options, index + 1);
  }
}
function ttsSpeak(text, options = {}) {
  if (!("speechSynthesis" in window)) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "zh-CN";
    const female = options.voice === "female";
    const male = options.voice === "male";
    const elongated = text.includes("～");
    u.rate = options.rate ?? (elongated ? 0.78 : 1.05 + Math.random() * 0.15);
    u.pitch = options.pitch ?? (female ? 1.16 : male ? 0.88 : 1.0 + Math.random() * 0.25);
    u.volume = Math.min(1, fxVol);
    if (female && zhFemaleVoice) u.voice = zhFemaleVoice;
    else if (male && zhMaleVoice) u.voice = zhMaleVoice;
    else if (zhVoice) u.voice = zhVoice;
    speechSynthesis.speak(u);
  } catch (_) { /* ignore */ }
}
let lastSpeakAt = 0;
export function speak(text, options = {}) {
  if (!voiceOn || fxVol <= 0) return;
  // 别打断上一句：事件密集时跳过新台词，避免被掐断、重叠成"瘆人"的乱响。
  const now = Date.now();
  const minGap = options.minGap ?? 1500;
  if (now - lastSpeakAt < minGap) return;
  lastSpeakAt = now;
  const playVoice = () => {
    if (!voiceOn || fxVol <= 0) return;
    if (options.forceTts) {
      ttsSpeak(text, options);
      return;
    }
    const keys = [...(options.clipKeys || []), clipKey(text)];
    if (!playClipByKey(keys, text, options)) ttsSpeak(text, options);
  };
  if (options.delay > 0) setTimeout(playVoice, options.delay);
  else playVoice();
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
  if (musicGain && ctx) musicGain.gain.setTargetAtTime(0.5 * musicVol, ctx.currentTime, 0.03);
  return musicVol;
}
export function setFxVol(v) {
  fxVol = Math.min(1, Math.max(0, v));
  localStorage.setItem("szp.fxVol", String(fxVol));
  if (master && ctx) master.gain.setTargetAtTime(fxVol, ctx.currentTime, 0.03);
  return fxVol;
}
export const audioState = () => ({ musicOn, voiceOn, musicVol, fxVol, started });
