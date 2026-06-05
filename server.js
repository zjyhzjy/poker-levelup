import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  addAiPlayer,
  buryKitty,
  callFriend,
  chooseForcedTrump,
  confirmDealer,
  createRoom,
  dealRound,
  decideAiBid,
  forceDealer,
  joinRoom,
  leaveSeat,
  makeBid,
  passBid,
  playCards,
  publicState,
  recommendPlay,
  resetToLobby,
  revealKittyCard,
  runAiStep,
  setTrustee,
  sit,
  startAuction,
  startRound
} from "./src/game.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const port = Number(process.env.PORT || 3000);
const rooms = new Map();
const sockets = new Map();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/api/rooms" && req.method === "POST") {
    const room = createRoom();
    rooms.set(room.code, room);
    sendJson(res, { code: room.code });
    return;
  }
  serveStatic(url.pathname, res);
});

server.on("upgrade", (req, socket) => {
  if (req.headers.upgrade?.toLowerCase() !== "websocket") {
    socket.destroy();
    return;
  }
  const key = req.headers["sec-websocket-key"];
  const accept = crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    ""
  ].join("\r\n"));

  // Assign a temporary playerId — may be overridden by reconnect
  const client = { socket, playerId: crypto.randomUUID(), roomCode: null, nickname: "" };
  sockets.set(socket, client);
  socket.on("data", (buffer) => handleFrame(client, buffer));
  socket.on("close", () => disconnect(client));
  socket.on("error", () => disconnect(client));
  send(client, "hello", { playerId: client.playerId });
});

server.listen(port, () => {
  console.log(`升级找朋友 running at http://localhost:${port}`);
});

function serveStatic(urlPath, res) {
  const safePath = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.normalize(path.join(publicDir, safePath));
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": contentType(filePath) });
    res.end(data);
  });
}

function sendJson(res, data) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function handleMessage(client, message) {
  try {
    const { type, payload = {} } = JSON.parse(message);

    // ── Reconnect: client sends their stored playerId ──────────────
    if (type === "reconnect") {
      const storedId = String(payload.playerId || "").trim();
      const code = String(payload.code || "").trim().toUpperCase();
      if (!storedId) throw new Error("无效的玩家ID");
      const room = rooms.get(code);
      if (!room) throw new Error("房间不存在");

      // Find the seat that held this playerId
      const seat = room.seats.find(s => s.playerId === storedId);
      if (seat) {
        // Re-use old playerId and reconnect
        client.playerId = storedId;
        client.roomCode = code;
        client.nickname = seat.nickname;
        seat.connected = true;
        room.spectators.delete(storedId);
        send(client, "hello", { playerId: client.playerId });
        broadcast(room);
      } else {
        // Not found — treat as normal join
        attachToRoom(client, room, payload.nickname);
      }
      return;
    }

    if (type === "createRoom") {
      const room = createRoom();
      rooms.set(room.code, room);
      // Adopt the client-owned stable id so future reconnects map to this seat.
      const stableId = String(payload.playerId || "").trim();
      if (stableId) client.playerId = stableId;
      attachToRoom(client, room, payload.nickname);
      return;
    }
    if (type === "joinRoom") {
      const code = String(payload.code || "").trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) throw new Error("房间不存在");
      // Try reconnect by playerId first
      const storedId = String(payload.playerId || "").trim();
      if (storedId) {
        const seat = room.seats.find(s => s.playerId === storedId);
        if (seat) {
          client.playerId = storedId;
          client.roomCode = code;
          client.nickname = seat.nickname;
          seat.connected = true;
          room.spectators.delete(storedId);
          send(client, "hello", { playerId: client.playerId });
          broadcast(room);
          return;
        }
        // Fresh join: still adopt the client-owned id so that if this player
        // later sits down, their seat is keyed by the stable id and reconnect works.
        client.playerId = storedId;
      }
      attachToRoom(client, room, payload.nickname);
      return;
    }

    // Ephemeral emote (throw tomato / send flower at a seat) — broadcast to the
    // whole room as a transient event, not part of the persistent game state.
    if (type === "emote") {
      const room = currentRoom(client);
      const target = Number(payload.target);
      if (!Number.isInteger(target) || target < 0 || target >= 5) return;
      const kind = payload.kind === "flower" ? "flower" : "tomato";
      const fromSeat = room.seats.find((s) => s.playerId === client.playerId)?.index ?? null;
      for (const c of sockets.values()) {
        if (c.roomCode === room.code) send(c, "emote", { from: fromSeat, target, kind });
      }
      return;
    }

    // Recommended play — compute via AI logic and reply only to the requester.
    if (type === "hint") {
      const room = currentRoom(client);
      let cardIds = [];
      try { cardIds = recommendPlay(room, client.playerId) || []; } catch { cardIds = []; }
      send(client, "hint", { cardIds });
      return;
    }

    const room = currentRoom(client);
    const actions = {
      sit:              () => sit(room, client.playerId, Number(payload.seatIndex), payload.nickname || client.nickname, payload.avatar),
      addAi:            () => addAiPlayer(room, Number(payload.seatIndex), payload.level),
      leaveSeat:        () => leaveSeat(room, client.playerId),
      startRound:       () => startRound(room, Math.random, { deal: false }),
      bid:              () => makeBid(room, client.playerId, payload.cardIds || []),
      passBid:          () => passBid(room, client.playerId),
      // Manual auction start — just transitions to auction phase, no auto-flip
      startAuction:     () => startAuction(room),
      // Manual reveal one card at a time
      revealKitty:      () => revealKittyCard(room),
      // Manual force dealer (after all 7 cards revealed and no bid)
      forceDealer:      () => {
        const lastCard = room.revealedKitty[room.revealedKitty.length - 1];
        if (!lastCard) throw new Error("还没有翻完底牌");
        forceDealer(room, lastCard);
      },
      chooseForcedTrump:() => chooseForcedTrump(room, client.playerId, payload.suit || null, { noTrump: payload.noTrump, cardIds: payload.cardIds || [] }),
      bury:             () => buryKitty(room, client.playerId, payload.cardIds || []),
      callFriend:       () => callFriend(room, client.playerId, payload),
      play:             () => playCards(room, client.playerId, payload.cardIds || []),
      setTrustee:       () => setTrustee(room, client.playerId, payload.on),
      nextRoundLobby:   () => resetToLobby(room)
    };
    if (!actions[type]) throw new Error("未知操作");
    actions[type]();
    broadcast(room);

    // Kick off the round-by-round dealing animation (~0.7s per round)
    if (type === "startRound" && room.dealing) {
      scheduleDealing(room);
    }

    // After a bid is placed, schedule 10s timeout for others to respond
    if (type === "bid" && room.currentBid && room.phase !== "burying") {
      scheduleBidTimeout(room);
    }

    // Let AI seats open/contest the bidding once a human acts in the auction.
    if (["bid", "passBid", "startAuction", "revealKitty"].includes(type)) {
      scheduleAiBids(room);
    }

    scheduleAi(room);
  } catch (error) {
    send(client, "error", { message: error.message });
  }
}

function attachToRoom(client, room, nickname) {
  client.roomCode = room.code;
  client.nickname = nickname?.trim() || client.nickname || "玩家";
  joinRoom(room, client.playerId, client.nickname);
  broadcast(room);
}

function currentRoom(client) {
  const room = rooms.get(client.roomCode);
  if (!room) throw new Error("请先进入房间");
  return room;
}

function broadcast(room) {
  for (const client of sockets.values()) {
    if (client.roomCode === room.code) send(client, "state", publicState(room, client.playerId));
  }
}

// Deal one round (~0.7s apart) until all cards are out, broadcasting after each
// so every client sees the hand grow.
const DEAL_ROUND_MS = 700;
function scheduleDealing(room) {
  setTimeout(() => {
    if (room.phase !== "dealing" || !room.dealing) return;
    let more;
    try {
      more = dealRound(room);
    } catch (_) {
      more = false;
    }
    broadcast(room);
    if (more) {
      scheduleDealing(room);
    } else {
      // Dealing finished. If a bid is pending, make sure it still gets resolved.
      if (room.phase === "dealing" && room.currentBid) scheduleBidTimeout(room);
      scheduleAiBids(room); // AI seats may now open the bidding
      scheduleAi(room);
    }
  }, DEAL_ROUND_MS);
}

// Let each AI seat consider bidding/responding, staggered, once per call. Driven
// by auction events (deal finished, a bid placed, a card revealed) so it respects
// the reveal/10s pacing instead of firing through the fast 350ms AI loop.
function scheduleAiBids(room) {
  const aiSeats = room.seats.filter((s) => s.isAi && s.playerId);
  aiSeats.forEach((seat, i) => {
    setTimeout(() => {
      if (room.dealing) return;
      if (!["auctionReady", "auction"].includes(room.phase)) return;
      if (room.bidResponses[seat.index]) return;                       // already acted
      if (room.currentBid && room.currentBid.seat === seat.index) return;
      try {
        const decision = decideAiBid(room, seat);
        if (decision && (!room.currentBid || decision.strength > room.currentBid.strength)) {
          makeBid(room, seat.playerId, decision.cardIds);
          broadcast(room);
          scheduleBidTimeout(room); // 10s window for this new bid
          scheduleAiBids(room);     // let the others respond to it
          scheduleAi(room);         // in case it confirmed the dealer immediately
        } else if (room.currentBid) {
          passBid(room, seat.playerId);
          broadcast(room);
          scheduleAi(room);
        }
        // else: nothing on the table and AI doesn't want it → wait for the human/翻底
      } catch (_) { /* state moved on; ignore */ }
    }, 500 + i * 650);
  });
}

// After a bid is placed, give other players 10s to respond before auto-confirming
function scheduleBidTimeout(room) {
  const bidAtSchedule = room.currentBid;
  if (!bidAtSchedule) return;
  setTimeout(() => {
    if (room.currentBid !== bidAtSchedule) return;
    if (!["dealing", "auctionReady", "auction"].includes(room.phase)) return;
    for (const seat of room.seats) {
      if (seat.playerId && !room.bidResponses[seat.index]) {
        room.bidResponses[seat.index] = "pass";
      }
    }
    // Still dealing: record passes but defer confirming until the deal finishes
    // (the kitty isn't assigned yet). finishDealing() will resolve it.
    if (room.dealing) { broadcast(room); return; }
    try { confirmDealer(room); broadcast(room); scheduleAi(room); } catch (_) {}
  }, 10000);
}

function scheduleAi(room) {
  setTimeout(() => {
    let moved = false;
    try {
      moved = runAiStep(room);
    } catch (error) {
      room.tableLog.push(`AI 操作失败：${error.message}`);
      broadcast(room);
      setTimeout(() => scheduleAi(room), 1500);
      return;
    }
    if (moved) {
      broadcast(room);
      scheduleAi(room);
    }
  }, 350);
}

function disconnect(client) {
  sockets.delete(client.socket);
  const room = client.roomCode ? rooms.get(client.roomCode) : null;
  if (!room) return;
  for (const seat of room.seats) {
    if (seat.playerId === client.playerId) seat.connected = false;
  }
  if (room.spectators.has(client.playerId)) room.spectators.get(client.playerId).connected = false;
  broadcast(room);
}

function send(client, type, payload) {
  const data = Buffer.from(JSON.stringify({ type, payload }));
  const header = data.length < 126
    ? Buffer.from([0x81, data.length])
    : Buffer.from([0x81, 126, data.length >> 8, data.length & 255]);
  client.socket.write(Buffer.concat([header, data]));
}

function handleFrame(client, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const byte1 = buffer[offset++];
    const byte2 = buffer[offset++];
    const opcode = byte1 & 0x0f;
    if (opcode === 0x8) { client.socket.end(); return; }
    let length = byte2 & 0x7f;
    if (length === 126) { length = buffer.readUInt16BE(offset); offset += 2; }
    else if (length === 127) { length = Number(buffer.readBigUInt64BE(offset)); offset += 8; }
    const masked = (byte2 & 0x80) !== 0;
    const mask = masked ? buffer.subarray(offset, offset + 4) : null;
    if (masked) offset += 4;
    const payload = buffer.subarray(offset, offset + length);
    offset += length;
    if (masked) { for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]; }
    if (opcode === 0x1) handleMessage(client, payload.toString("utf8"));
  }
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}
