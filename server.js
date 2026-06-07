import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  addAiPlayer,
  buryKitty,
  callSixTrump,
  callFriend,
  chooseForcedTrump,
  confirmDealer,
  createRoom,
  dealRound,
  decideAiBid,
  decideAiSixTrump,
  chooseAiBury,
  forceDealer,
  joinRoom,
  leaveSeat,
  makeBid,
  passBid,
  passSixTrump,
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
const BID_RESPONSE_TIMEOUT_MS = 10000;
const BURY_TIMEOUT_MS = 60000;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/api/rooms" && req.method === "POST") {
    const room = createRoom(undefined, { seatCount: Number(url.searchParams.get("seatCount")) });
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
  socket.on("end", () => disconnect(client)); // 半开 FIN（手机锁屏/切后台/弱网）也要下线，否则自动托管不触发、整桌卡死
  send(client, "hello", { playerId: client.playerId });
});

server.listen(port, () => {
  console.log(`升级找朋友 running at http://localhost:${port}`);
});

// ── 房间回收：无任何活跃连接持续一段时间的房间从内存清除（并清掉其待触发的
// 托管计时器），防止废弃房间和 POST /api/rooms 刷量造成内存泄漏。
const ROOM_EMPTY_TTL_MS = 10 * 60 * 1000;
const ROOM_SWEEP_MS = 2 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const hasLiveClient = [...sockets.values()].some((c) => c.roomCode === code);
    if (hasLiveClient) { room.emptySince = null; continue; }
    if (room.emptySince == null) { room.emptySince = now; continue; }
    if (now - room.emptySince > ROOM_EMPTY_TTL_MS) {
      if (room.trusteeTimers) for (const t of Object.values(room.trusteeTimers)) clearTimeout(t);
      rooms.delete(code);
    }
  }
}, ROOM_SWEEP_MS).unref?.();

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
      const room = createRoom(undefined, { seatCount: Number(payload.seatCount) });
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

    if (type === "ping") {
      send(client, "pong", { sentAt: payload.sentAt || 0, serverAt: Date.now() });
      return;
    }

    // Ephemeral emote (throw tomato / send flower at a seat) — broadcast to the
    // whole room as a transient event, not part of the persistent game state.
    if (type === "emote") {
      const room = currentRoom(client);
      const target = Number(payload.target);
      if (!Number.isInteger(target) || target < 0 || target >= room.seatCount) return;
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
      sixCallTrump:     () => callSixTrump(room, client.playerId, payload.cardIds || []),
      sixPassTrump:     () => passSixTrump(room, client.playerId),
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
    // 推进/重置整桌牌局或改动座位的动作（开局、塞 AI、翻底、强制定庄、踹回大厅），
    // 必须由已入座玩家发起，防止观战者或伪造连接搅局。带 playerId 的出牌/抢庄等
    // 动作已在引擎层按座位归属校验，此处只补这批不带身份的房间管理动作。
    // 公开部署时可进一步收紧为仅房主（room.hostId === client.playerId）。
    const seatedOnly = ["startRound", "addAi", "startAuction", "revealKitty", "forceDealer", "nextRoundLobby"];
    if (seatedOnly.includes(type) && !room.seats.some((s) => s.playerId === client.playerId)) {
      throw new Error("只有入座玩家可以操作");
    }
    actions[type]();
    broadcast(room);

    // Kick off the round-by-round dealing animation (~0.7s per round)
    if (type === "startRound" && room.dealing) {
      scheduleDealing(room);
    }

    // After a bid is placed, schedule timeout for others to respond
    if ((type === "bid" || type === "sixCallTrump") && room.currentBid && room.phase !== "burying") {
      scheduleBidTimeout(room);
    }

    if (room.phase === "burying") {
      scheduleBuryTimeout(room);
    }

    // Let AI seats open/contest the bidding once a human acts in the auction.
    if (["bid", "passBid", "startAuction", "revealKitty", "sixCallTrump", "sixPassTrump"].includes(type)) {
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
      if (room.currentBid && ["dealing", "auctionReady", "auction"].includes(room.phase)) scheduleBidTimeout(room);
      scheduleAiBids(room); // AI seats may now open the bidding
      scheduleAi(room);
    }
  }, DEAL_ROUND_MS);
}

// Let each AI seat consider bidding/responding, staggered, once per call. Driven
// by auction events (deal finished, a bid placed, a card revealed) so it respects
// the reveal/response-timeout pacing instead of firing through the fast 350ms AI loop.
function scheduleAiBids(room) {
  const aiSeats = room.seats.filter((s) => s.isAi && s.playerId);
  aiSeats.forEach((seat, i) => {
    setTimeout(() => {
      if (room.dealing) return;
      if (!["auctionReady", "auction", "sixTrump"].includes(room.phase)) return;
      if (room.bidResponses[seat.index]) return;                       // already acted
      if (room.currentBid && room.currentBid.seat === seat.index) return;
      try {
        const sixMode = room.phase === "sixTrump";
        const decision = sixMode ? decideAiSixTrump(room, seat) : decideAiBid(room, seat);
        if (decision && (!room.currentBid || decision.strength > room.currentBid.strength)) {
          if (sixMode) callSixTrump(room, seat.playerId, decision.cardIds);
          else makeBid(room, seat.playerId, decision.cardIds);
          broadcast(room);
          scheduleBidTimeout(room); // response window for this new bid
          scheduleAiBids(room);     // let the others respond to it
          scheduleAi(room);         // in case it confirmed the dealer immediately
        } else if (room.currentBid || sixMode) {
          if (sixMode) passSixTrump(room, seat.playerId);
          else passBid(room, seat.playerId);
          broadcast(room);
          scheduleAi(room);
        }
        // else: nothing on the table and AI doesn't want it → wait for the human/翻底
      } catch (_) { /* state moved on; ignore */ }
    }, 500 + i * 650);
  });
}

// After a bid is placed, give other players a full response window before auto-confirming.
// If someone reveals during the deal, the response window starts after dealing
// finishes so players still get the full visible time to react.
function scheduleBidTimeout(room, delay = BID_RESPONSE_TIMEOUT_MS) {
  const bidAtSchedule = room.currentBid;
  if (!bidAtSchedule) return;
  setTimeout(() => {
    if (room.currentBid !== bidAtSchedule) return;
    if (!["dealing", "auctionReady", "auction", "sixTrump"].includes(room.phase)) return;
    if (room.dealing) {
      scheduleBidTimeout(room);
      return;
    }
    if ((room.bidResponseReadyAt || 0) > Date.now()) {
      scheduleBidTimeout(room, Math.max(20, room.bidResponseReadyAt - Date.now()));
      return;
    }
    try {
      if (room.phase === "sixTrump") {
        if (room.currentBid) {
          for (const seat of room.seats) {
            if (seat.playerId && !room.bidResponses[seat.index]) {
              passSixTrump(room, seat.playerId);
              if (room.phase !== "sixTrump") break;
            }
          }
        }
      } else {
        for (const seat of room.seats) {
          if (seat.playerId && !room.bidResponses[seat.index]) {
            room.bidResponses[seat.index] = "pass";
          }
        }
        confirmDealer(room);
      }
      broadcast(room); scheduleAi(room);
    } catch (_) {}
  }, delay);
}

function scheduleAi(room) {
  scheduleAutoTrustee(room); // 轮到掉线真人时宽限后自动托管，避免整桌卡死
  if (room.phase === "burying") scheduleBuryTimeout(room);
  if (room.phase === "playing" && (room.trickPauseUntil || 0) > Date.now()) {
    setTimeout(() => scheduleAi(room), Math.max(20, room.trickPauseUntil - Date.now() + 20));
    return;
  }
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

function scheduleBuryTimeout(room) {
  if (room.buryTimeoutSeat === room.dealerSeat && room.buryTimeoutAt && room.buryTimeoutAt > Date.now()) return;
  room.buryTimeoutSeat = room.dealerSeat;
  room.buryTimeoutAt = Date.now() + BURY_TIMEOUT_MS;
  setTimeout(() => {
    if (room.phase !== "burying" || room.dealerSeat !== room.buryTimeoutSeat) return;
    const dealer = room.seats[room.dealerSeat];
    if (!dealer?.playerId) return;
    try {
      const cards = chooseAiBury(room, dealer).map((card) => card.id);
      buryKitty(room, dealer.playerId, cards);
      room.tableLog.push(`${dealer.nickname} 扣底超时，系统自动扣底。`);
      broadcast(room);
      scheduleAi(room);
    } catch (error) {
      room.tableLog.push(`自动扣底失败：${error.message}`);
      broadcast(room);
    }
  }, BURY_TIMEOUT_MS);
}

// ── 掉线自动托管：轮到当前该行动的座位却是掉线真人时，宽限若干秒后自动托管，
// 交给 runAiStep 接管，避免整桌无限等待。玩家重连后可手动取消托管。
const DISCONNECT_TRUSTEE_MS = 20000;
function actorSeat(room) {
  if (room.phase === "playing") return room.turnSeat;
  if (["forcedSuit", "burying", "friend"].includes(room.phase)) return room.dealerSeat;
  return null; // 抢庄阶段由 scheduleBidTimeout 兜底
}
function scheduleAutoTrustee(room) {
  const idx = actorSeat(room);
  if (idx == null) return;
  const seat = room.seats[idx];
  if (!seat || !seat.playerId || seat.isAi || seat.trustee || seat.connected) return;
  room.trusteeTimers = room.trusteeTimers || {};
  if (room.trusteeTimers[idx]) return; // 已在计时
  room.trusteeTimers[idx] = setTimeout(() => {
    delete room.trusteeTimers[idx];
    const s = room.seats[idx];
    if (s && s.playerId && !s.isAi && !s.connected && actorSeat(room) === idx) {
      try { setTrustee(room, s.playerId, true); } catch (_) { return; }
      room.tableLog.push(`${s.nickname} 掉线，已自动托管。`);
      broadcast(room);
      scheduleAi(room);
    }
  }, DISCONNECT_TRUSTEE_MS);
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
  scheduleAutoTrustee(room); // 掉线的正是当前该行动的人时，启动自动托管计时
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
