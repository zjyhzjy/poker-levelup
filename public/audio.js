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
let volume = Math.min(1, Math.max(0, parseFloat(localStorage.getItem("szp.vol") ?? "0.7"))); // 0..1

function ensureCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = volume;
    master.connect(ctx.destination);
    musicGain = ctx.createGain();
    musicGain.gain.value = 0.0;
    musicGain.connect(master);
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

// File-based BGM: if public/bgm.mp3 exists, loop it (so you can drop in any track
// you're allowed to use); otherwise fall back to the synth loop below.
let bgmEl = null; // HTMLAudioElement | "missing" | null
function startMusic() {
  if (!ensureCtx()) return;
  if (bgmEl === "missing") { startSynthMusic(); return; }
  if (!bgmEl) {
    bgmEl = new Audio("/bgm.mp3");
    bgmEl.loop = true;
    bgmEl.volume = Math.min(1, volume);
    bgmEl.addEventListener("error", () => { if (bgmEl !== "missing") { bgmEl = "missing"; startSynthMusic(); } });
  }
  bgmEl.volume = Math.min(1, volume);
  const p = bgmEl.play();
  if (p && p.catch) p.catch(() => { bgmEl = "missing"; startSynthMusic(); });
}
function stopMusic() {
  if (bgmEl && bgmEl !== "missing") { try { bgmEl.pause(); } catch (_) {} }
  stopSynthMusic();
}

function startSynthMusic() {
  if (!ensureCtx() || musicTimer) return;
  musicGain.gain.cancelScheduledValues(ctx.currentTime);
  musicGain.gain.linearRampToValueAtTime(0.5, ctx.currentTime + 1.5);
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
      c.volume = Math.min(1, volume);
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
  }
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
    u.volume = Math.min(1, volume + 0.2);
    if (zhVoice) u.voice = zhVoice;
    speechSynthesis.speak(u);
  } catch (_) { /* ignore */ }
}
export function speak(text) {
  if (!voiceOn) return;
  const key = clipKey(text);
  if (clips[key] === "missing") { ttsSpeak(text); return; }
  let c = clips[key];
  if (!c) { c = new Audio(`/voice/${encodeURIComponent(key)}.mp3`); clips[key] = c; }
  try {
    c.volume = Math.min(1, volume + 0.2);
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
export function setVolume(v) {
  volume = Math.min(1, Math.max(0, v));
  localStorage.setItem("szp.vol", String(volume));
  if (master) master.gain.setTargetAtTime(volume, ctx.currentTime, 0.03);
  if (bgmEl && bgmEl !== "missing") bgmEl.volume = Math.min(1, volume);
  return volume;
}
export const audioState = () => ({ musicOn, voiceOn, volume, started });
