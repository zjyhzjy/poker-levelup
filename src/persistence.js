// Room standings persistence — keeps the 累计战绩/等级 of a room durable across
// Cloudflare drops AND server restarts.
//
// We persist ONLY the standings (each seat's level + occupancy + the round/dealer
// bookkeeping needed to continue), NOT the in-progress hand. On reload the table is
// restored to a between-rounds LOBBY with levels intact; players reconnect by
// playerId and the host starts the next round from the correct levels. This keeps
// the on-disk shape tiny and avoids serialising mid-trick state, timers and sockets.
//
// Files live one-JSON-per-room under .data/rooms/<CODE>.json (gitignored). Writes are
// signature-gated (only when standings actually change) and atomic (tmp + rename), so
// the frequent broadcast() hook is cheap and a crash mid-write never corrupts a file.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRoom } from "./game.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", ".data", "rooms");
const TTL_MS = 14 * 24 * 60 * 60 * 1000; // standings older than 14 days are treated as expired

function ensureDir() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) { /* best-effort */ } }
const safeCode = (code) => String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const fileFor = (code) => path.join(DATA_DIR, `${safeCode(code)}.json`);

// The persisted snapshot: levels + seat occupancy + round/dealer bookkeeping only.
export function standingsOf(room) {
  return {
    v: 1,
    code: room.code,
    mode: room.mode,
    seatCount: room.seatCount,
    round: room.round || 0,
    teamLevels: room.teamLevels ?? null, // fixed-team modes (4/6): per-team shared level
    firstLevel: room.firstLevel ?? null,
    nextDealerSeat: room.nextDealerSeat ?? null, // drives dealer rotation into next round
    dealerSeat: room.dealerSeat ?? null,
    hostId: room.hostId ?? null,
    savedAt: Date.now(),
    seats: room.seats
      .filter((s) => s.playerId || s.isAi) // only occupied seats
      .map((s) => ({
        index: s.index,
        playerId: s.playerId ?? null,
        nickname: s.nickname ?? "",
        avatar: s.avatar ?? null,
        level: s.level ?? null,        // 5-player carries the per-seat level here
        isAi: !!s.isAi,
        aiLevel: s.aiLevel ?? null
      }))
  };
}

// Cheap change-signature so the every-broadcast hook skips redundant writes — it only
// covers what we persist (round, team levels, and each seat's occupant + level).
function signature(room) {
  const seats = room.seats
    .map((s) => `${s.index}:${s.playerId || (s.isAi ? `ai/${s.aiLevel || ""}` : "-")}:${s.level ?? "-"}`)
    .join("|");
  const tl = room.teamLevels ? `${room.teamLevels[0]}/${room.teamLevels[1]}` : "-";
  return `${room.round || 0}#${tl}#${room.nextDealerSeat ?? "-"}#${seats}`;
}

// Persist a room's standings if (a) it has a real human seat and (b) something we
// persist actually changed. Never throws — disk errors must not break the game.
export function saveStandings(room) {
  if (!room || !room.code) return;
  if (!room.seats.some((s) => s.playerId && !s.isAi)) return; // no human → nothing worth saving
  const sig = signature(room);
  if (sig === room._standSig) return; // unchanged since last write
  room._standSig = sig;
  try {
    ensureDir();
    const f = fileFor(room.code);
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(standingsOf(room)));
    fs.renameSync(tmp, f); // atomic replace on the same filesystem
  } catch (_) { /* swallow — persistence is best-effort */ }
}

// Read a saved snapshot for a code, or null if missing / corrupt / expired.
export function loadStandings(code) {
  try {
    const d = JSON.parse(fs.readFileSync(fileFor(code), "utf8"));
    if (!d || d.v !== 1) return null;
    if (d.savedAt && Date.now() - d.savedAt > TTL_MS) return null;
    return d;
  } catch (_) { return null; }
}

// Rebuild an in-memory room from saved standings: a between-rounds LOBBY with levels
// and seat occupancy restored, ready for players to reconnect and start a new round.
export function roomFromStandings(d) {
  if (!d || !d.code) return null;
  const room = createRoom(d.code, { mode: d.mode, seatCount: d.seatCount });
  room.round = d.round || 0;
  if (d.teamLevels) room.teamLevels = { ...d.teamLevels };
  if (d.firstLevel != null) room.firstLevel = d.firstLevel;
  if (d.nextDealerSeat != null) room.nextDealerSeat = d.nextDealerSeat;
  room.hostId = d.hostId ?? null;
  for (const s of d.seats || []) {
    const seat = room.seats[s.index];
    if (!seat) continue;
    seat.playerId = s.playerId ?? null;
    seat.nickname = s.nickname ?? "";
    seat.avatar = s.avatar ?? null;
    seat.level = s.level ?? null;
    seat.isAi = !!s.isAi;
    seat.aiLevel = s.aiLevel ?? null;
    seat.connected = false; // nobody is live yet — they reconnect by playerId
    if (seat.isAi) { seat.aiBias = 0; seat.aiRngState = ((s.index + 1) * 0x9e3779b9) | 0; } // give each AI a distinct RNG
  }
  // Make sure the first post-restore change re-writes the file.
  room._standSig = signature(room);
  return room;
}

// Best-effort removal of standings files whose snapshot is older than the TTL.
export function sweepExpiredStandings() {
  try {
    for (const name of fs.readdirSync(DATA_DIR)) {
      if (!name.endsWith(".json")) continue;
      const code = name.slice(0, -5);
      if (loadStandings(code) === null) { try { fs.unlinkSync(fileFor(code)); } catch (_) {} }
    }
  } catch (_) { /* dir may not exist yet */ }
}
