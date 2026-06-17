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
  kickAi,
  kickSeatByVote,
  leaveSeat,
  makeBid,
  passBid,
  passSixTrump,
  playCards,
  publicState,
  buildSharedState,
  projectStateForViewer,
  recommendPlay,
  resetToLobby,
  revealKittyCard,
  runAiStep,
  setTrustee,
  sit,
  startAuction,
  startRound,
  takeoverAiSeat,
  loadAiWeights
} from "./src/game.js";
import { pimcChoosePlay } from "./src/ai/pimc.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 自对弈调参权重默认【关闭】：它在自对弈指标上看着更强(+0.46)，但实为过拟合——
// 把"给敌家送分"的惩罚调到几乎为 0(fGiftPts 3.5→0.2)、不保护自己分(fRiskOwnPts→0)，
// 实战体感很笨。故默认用出厂手调权重。要再试调参版可设 USE_TUNED_WEIGHTS=1。
if (process.env.USE_TUNED_WEIGHTS === "1") {
  try {
    const wf = path.join(__dirname, "bench", "tuned-weights.json");
    if (fs.existsSync(wf)) { const tuned = JSON.parse(fs.readFileSync(wf, "utf8")); loadAiWeights(tuned.weights || {}); console.log(`AI 权重：已载入调参权重（gen ${tuned.generation}）`); }
  } catch (e) { console.log(`AI 权重：调参权重载入失败：${e.message}`); }
} else {
  console.log("AI 权重：使用出厂手调权重（调参权重默认关闭——过拟合，实战偏笨）");
}
const publicDir = path.join(__dirname, "public");

// 最后一道防线：任何未捕获的异常/Promise 拒绝都只记录、不让进程退出，
// 避免单个 bug（如某次广播/定时器回调抛错）把整台服务器拖垮、所有人同时掉线。
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err && err.stack ? err.stack : err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason && reason.stack ? reason.stack : reason);
});

const port = Number(process.env.PORT || 3000);
const rooms = new Map();
const sockets = new Map();
const BID_RESPONSE_TIMEOUT_MS = 10000;
const BURY_TIMEOUT_MS = 120000;
// 搜索型 AI 的 PIMC 预算（按难度档）。timeBudgetMs 给每步思考设上限，避免阻塞
// 服务端事件循环过久（回合制 + 友人对局可接受）。rollout 用启发式，不会递归回
// 搜索。可用环境变量覆盖时间预算。
//   强  ：轻量搜索，采样少、预算短 → 仍近乎秒出，但已用上"记牌器"推演。
//   大师：深度搜索，采样多、预算长 → 最强，出牌略慢。
const SEARCH_OPTS = {
  hard:   { determinizations: 24, maxCandidates: 6, timeBudgetMs: Number(process.env.HARD_PIMC_MS || 400),    rolloutLevel: "hard" },
  master: { determinizations: 40, maxCandidates: 8, timeBudgetMs: Number(process.env.MASTER_PIMC_MS || 1200), rolloutLevel: "hard" }
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/api/rooms" && req.method === "POST") {
    const room = createRoom(undefined, { seatCount: Number(url.searchParams.get("seatCount")) });
    rooms.set(room.code, room);
    sendJson(res, { code: room.code });
    return;
  }
  // 自定义图片头像：列出 public/avatars/ 里的图片文件，前端据此追加为可选头像。
  // 把你自己拥有版权/使用权的图片丢进该文件夹即可，无需改代码。
  if (url.pathname === "/api/avatars" && req.method === "GET") {
    let files = [];
    try {
      files = fs.readdirSync(path.join(publicDir, "avatars"))
        .filter((f) => /\.(png|jpe?g|gif|webp|svg)$/i.test(f))
        .sort();
    } catch (_) { files = []; }
    sendJson(res, { avatars: files });
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
    const hasLiveClient = room.clients && room.clients.size > 0;
    if (hasLiveClient) { room.emptySince = null; continue; }
    if (room.emptySince == null) { room.emptySince = now; continue; }
    if (now - room.emptySince > ROOM_EMPTY_TTL_MS) {
      if (room.trusteeTimers) for (const t of Object.values(room.trusteeTimers)) clearTimeout(t);
      rooms.delete(code);
    }
  }
}, ROOM_SWEEP_MS).unref?.();

function serveStatic(urlPath, res) {
  let decoded = urlPath;
  try { decoded = decodeURIComponent(urlPath); } catch (_) { /* malformed % — use raw */ }
  const safePath = decoded === "/" ? "/index.html" : decoded; // 解码后才能命中中文文件名（语音录音）
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
        setClientRoom(client, room);
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
          setClientRoom(client, room);
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
      const kind = ["tomato", "flower", "poop", "pig", "coffee"].includes(payload.kind) ? payload.kind : "tomato";
      const fromSeat = room.seats.find((s) => s.playerId === client.playerId)?.index ?? null;
      for (const c of room.clients || []) {
        try { send(c, "emote", { from: fromSeat, target, kind }); } catch (_) { /* dead socket */ }
      }
      return;
    }

    if (type === "kickStart") {
      const room = currentRoom(client);
      startKickVote(room, client, Number(payload.targetSeat));
      broadcast(room);
      return;
    }

    if (type === "kickAgree") {
      const room = currentRoom(client);
      agreeKickVote(room, client, String(payload.voteId || ""));
      broadcast(room);
      scheduleAi(room);
      return;
    }

    // Recommended play — deterministic legal minimum, separate from AI strategy.
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
      takeoverAi:       () => takeoverAiSeat(room, client.playerId, Number(payload.seatIndex), payload.nickname || client.nickname, payload.avatar),
      addAi:            () => addAiPlayer(room, Number(payload.seatIndex), payload.level),
      kickAi:           () => kickAi(room, Number(payload.seatIndex)),
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
    if ((type === "bid" || type === "sixCallTrump" || type === "chooseForcedTrump") && room.currentBid && room.phase !== "burying") {
      scheduleBidTimeout(room);
    }

    if (room.phase === "burying") {
      scheduleBuryTimeout(room);
    }

    // Let AI seats open/contest the bidding once a human acts in the auction
    // (including the 翻底 open-亮 window after the roulette lands).
    if (["bid", "passBid", "startAuction", "revealKitty", "sixCallTrump", "sixPassTrump", "chooseForcedTrump"].includes(type)) {
      scheduleAiBids(room);
    }

    scheduleAi(room);
  } catch (error) {
    send(client, "error", { message: error.message });
  }
}

// Track which clients are in a room so broadcast() iterates only this room's
// members instead of scanning every socket on the server. A client only ever
// belongs to one room, but guard against a same-socket room switch just in case.
function setClientRoom(client, room) {
  if (client.roomCode && client.roomCode !== room.code) {
    rooms.get(client.roomCode)?.clients?.delete(client);
  }
  client.roomCode = room.code;
  (room.clients ??= new Set()).add(client);
}

function attachToRoom(client, room, nickname) {
  setClientRoom(client, room);
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
  if (!room.clients || room.clients.size === 0) return;
  const shared = buildSharedState(room); // heavy work done once, reused per viewer
  for (const client of room.clients) {
    try { send(client, "state", projectStateForViewer(shared, room, client.playerId)); }
    catch (_) { /* dead socket — disconnect handler will clean it up */ }
  }
}

function startKickVote(room, client, targetSeatIndex) {
  const initiator = room.seats.find((s) => s.playerId === client.playerId);
  if (!initiator) throw new Error("只有入座玩家可以发起踢人");
  const target = room.seats[targetSeatIndex];
  if (!target || !target.playerId) throw new Error("目标玩家不存在");
  if (target.index === initiator.index) throw new Error("不能踢自己");
  if (room.kickVote?.timer) clearTimeout(room.kickVote.timer);
  const vote = {
    id: crypto.randomUUID(),
    initiatorSeat: initiator.index,
    targetSeat: target.index,
    initiatorName: initiator.nickname || `座位${initiator.index + 1}`,
    targetName: target.nickname || `座位${target.index + 1}`,
    targetPlayerId: target.isAi ? null : target.playerId,
    approvals: new Set([initiator.index])
  };
  vote.timer = setTimeout(() => {
    if (room.kickVote?.id === vote.id) {
      room.kickVote = null;
      broadcast(room);
    }
  }, 20000);
  room.kickVote = vote;
  room.tableLog.push(`${vote.initiatorName} 发起对 ${vote.targetName} 的踢人投票。`);
  const payload = {
    voteId: vote.id,
    initiatorSeat: vote.initiatorSeat,
    targetSeat: vote.targetSeat,
    initiatorName: vote.initiatorName,
    targetName: vote.targetName
  };
  for (const c of sockets.values()) {
    if (c.roomCode !== room.code) continue;
    const seat = room.seats.find((s) => s.playerId === c.playerId);
    if (!seat || seat.index === vote.initiatorSeat || seat.index === vote.targetSeat) continue;
    send(c, "kickVote", payload);
  }
}

function agreeKickVote(room, client, voteId) {
  const vote = room.kickVote;
  if (!vote || vote.id !== voteId) throw new Error("踢人投票已失效");
  const voter = room.seats.find((s) => s.playerId === client.playerId);
  if (!voter) throw new Error("只有入座玩家可以投票");
  if (voter.index === vote.targetSeat) throw new Error("被踢玩家不能参与投票");
  vote.approvals.add(voter.index);
  room.tableLog.push(`${voter.nickname} 同意踢出 ${vote.targetName}。`);
  if (vote.approvals.size < 2) return;
  if (vote.timer) clearTimeout(vote.timer);
  const targetPlayerId = vote.targetPlayerId;
  kickSeatByVote(room, vote.targetSeat);
  if (targetPlayerId) room.spectators.delete(targetPlayerId);
  room.tableLog.push(`踢人投票通过，${vote.targetName} 已离开座位。`);
  room.kickVote = null;
  if (targetPlayerId) {
    for (const c of sockets.values()) {
      if (c.playerId !== targetPlayerId || c.roomCode !== room.code) continue;
      send(c, "kicked", { message: "你已被投票移出座位。" });
      room.clients?.delete(c);
      c.roomCode = null;
    }
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
      if (!["auctionReady", "auction", "sixTrump", "forcedSuit"].includes(room.phase)) return;
      // 翻底轮盘还在转时不抢答（落定后 room.forceSpin 被置空才开放）
      if (room.phase === "forcedSuit" && room.forceSpin) return;
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
    if (!["dealing", "auctionReady", "auction", "sixTrump", "forcedSuit"].includes(room.phase)) return;
    // 翻底轮盘转动期间不结算响应窗口
    if (room.phase === "forcedSuit" && room.forceSpin) {
      scheduleBidTimeout(room);
      return;
    }
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

// 搜索档（强 / 大师）：轮到搜索型 AI（或其托管座位）在出牌阶段行动时，用 PIMC
// 搜索选牌而非默认启发式。返回 true 表示已出牌。任何异常都吞掉并返回 false，让外层
// 回退到 runAiStep（即该座位的启发式出牌），保证绝不卡死。
function searchStep(room) {
  if (room.phase !== "playing") return false;
  if ((room.trickPauseUntil || 0) > Date.now()) return false;
  const seat = room.seats[room.turnSeat];
  if (!seat || !(seat.isAi || seat.trustee)) return false;
  // 托管的真人座位（aiLevel 为空）默认用"强"档搜索，让自动出牌也用上记牌器。
  const opts = SEARCH_OPTS[seat.aiLevel] || (seat.trustee ? SEARCH_OPTS.hard : null);
  if (!opts) return false; // 弱/中：纯启发式，不搜索
  try {
    const cards = pimcChoosePlay(room, room.turnSeat, opts);
    if (!cards || !cards.length) return false;
    playCards(room, seat.playerId, cards.map((c) => c.id));
    return true;
  } catch (_) {
    return false; // 回退到启发式
  }
}

function scheduleAi(room) {
  scheduleAutoTrustee(room); // 轮到掉线真人时宽限后自动托管，避免整桌卡死
  if (room.phase === "burying") scheduleBuryTimeout(room);
  if (room.phase === "playing" && (room.trickPauseUntil || 0) > Date.now()) {
    setTimeout(() => scheduleAi(room), Math.max(20, room.trickPauseUntil - Date.now() + 20));
    return;
  }
  // 翻底强制坐庄：轮盘转动期间不行动；落定（count*interval 到点）即开放亮主窗口。
  if (room.phase === "forcedSuit" && room.forceSpin) {
    const spin = room.forceSpin;
    const until = (spin.startedAt || 0) + Math.max(0, Number(spin.count ?? 1)) * (spin.intervalMs || 1000);
    if (until > Date.now()) {
      setTimeout(() => scheduleAi(room), Math.max(20, until - Date.now() + 50));
      return;
    }
    // 轮盘落定：清空 forceSpin，开一次开放亮主窗口（所有人可亮主/不亮，强制庄家可亮或沿用底牌花色）。
    room.forceSpin = null;
    room.bidResponseReadyAt = Date.now() + BID_RESPONSE_TIMEOUT_MS;
    broadcast(room);
    scheduleAiBids(room);     // 非庄家 AI 亮主/不亮
    scheduleBidTimeout(room); // 都不亮 / 庄家不定则超时按底牌花色定庄
  }
  setTimeout(() => {
    let moved = false;
    try {
      moved = searchStep(room) || runAiStep(room);
    } catch (error) {
      room.tableLog.push(`AI 操作失败：${error.message}`);
      broadcast(room);
      setTimeout(() => scheduleAi(room), 1500);
      return;
    }
    if (moved) {
      broadcast(room);
      if (room.phase === "forcedSuit") {
        scheduleBidTimeout(room);
        scheduleAiBids(room); // let other seats respond to the dealer's 亮/不亮
      }
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

// ── 自动托管：轮到某座位却迟迟不行动时，宽限若干秒后自动托管，交给 runAiStep 接管，
// 避免整桌无限等待。玩家重连/手动取消托管即可收回。
//   · 掉线真人：任何阶段 20s 后托管。
//   · 在线但挂机：仅出牌 / 叫朋友阶段 90s 后托管（强制定主有 10s 响应超时、扣底有 2 分钟
//     超时各自兜底，这里不重复接管，以免压缩玩家思考时间）。
const DISCONNECT_TRUSTEE_MS = 20000;
const CONNECTED_IDLE_MS = 90000;
function actorSeat(room) {
  if (room.phase === "playing") return room.turnSeat;
  if (["forcedSuit", "burying", "friend"].includes(room.phase)) return room.dealerSeat;
  return null; // 抢庄阶段由 scheduleBidTimeout 兜底
}
function scheduleAutoTrustee(room) {
  room.trusteeTimers = room.trusteeTimers || {};
  const idx = actorSeat(room);
  // 当前等待的座位变了（有人行动 / 阶段切换）就清掉旧计时，避免对已行动的玩家误托管。
  for (const key of Object.keys(room.trusteeTimers)) {
    if (Number(key) !== idx) { clearTimeout(room.trusteeTimers[key]); delete room.trusteeTimers[key]; }
  }
  if (idx == null) return;
  const seat = room.seats[idx];
  if (!seat || !seat.playerId || seat.isAi || seat.trustee) return;
  let grace = null;
  if (!seat.connected) grace = DISCONNECT_TRUSTEE_MS;
  else if (room.phase === "playing" || room.phase === "friend") grace = CONNECTED_IDLE_MS;
  if (grace == null) return; // 在线 + 扣底/强制定主：交给各自的超时兜底
  if (room.trusteeTimers[idx]) return; // 已在计时
  room.trusteeTimers[idx] = setTimeout(() => {
    delete room.trusteeTimers[idx];
    const s = room.seats[idx];
    if (s && s.playerId && !s.isAi && !s.trustee && actorSeat(room) === idx) {
      try { setTrustee(room, s.playerId, true); } catch (_) { return; }
      room.tableLog.push(`${s.nickname} ${s.connected ? "长时间未操作" : "掉线"}，已自动托管。`);
      broadcast(room);
      scheduleAi(room);
    }
  }, grace);
}

function disconnect(client) {
  sockets.delete(client.socket);
  const room = client.roomCode ? rooms.get(client.roomCode) : null;
  if (!room) return;
  room.clients?.delete(client);
  for (const seat of room.seats) {
    if (seat.playerId === client.playerId) seat.connected = false;
  }
  if (room.spectators.has(client.playerId)) room.spectators.get(client.playerId).connected = false;
  broadcast(room);
  scheduleAutoTrustee(room); // 掉线的正是当前该行动的人时，启动自动托管计时
}

function send(client, type, payload) {
  const data = Buffer.from(JSON.stringify({ type, payload }));
  sendFrame(client, 0x1, data);
}

function sendFrame(client, opcode, data = Buffer.alloc(0)) {
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.from([0x80 | opcode, 126, (len >> 8) & 0xff, len & 0xff]);
  } else {
    // ≥64KB 必须用 64-bit(127) 长度，否则 16-bit 会溢出截断、整帧损坏、连接错位。
    // 6 人长局的 state 广播确实可能破 64KB。
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  client.socket.write(Buffer.concat([header, data]));
}

// 累积每个连接的接收缓冲，只解析“完整”的帧——一个帧被 TCP 拆到多个 data 段时
// （弱网/隧道很常见）保留残片等待续传，避免长度读错导致此后所有消息全部错位。
// 同时支持分片帧（opcode 0x0 续帧 + FIN 位）。
function handleFrame(client, chunk) {
  client.recvBuffer = client.recvBuffer ? Buffer.concat([client.recvBuffer, chunk]) : chunk;
  let buf = client.recvBuffer;
  let offset = 0;
  while (true) {
    if (buf.length - offset < 2) break;                 // 连帧头都不够
    const byte1 = buf[offset];
    const byte2 = buf[offset + 1];
    const fin = (byte1 & 0x80) !== 0;
    const opcode = byte1 & 0x0f;
    const masked = (byte2 & 0x80) !== 0;
    let len = byte2 & 0x7f;
    let headerLen = 2;
    if (len === 126) {
      if (buf.length - offset < 4) break;
      len = buf.readUInt16BE(offset + 2);
      headerLen = 4;
    } else if (len === 127) {
      if (buf.length - offset < 10) break;
      len = Number(buf.readBigUInt64BE(offset + 2));
      headerLen = 10;
    }
    const maskLen = masked ? 4 : 0;
    if (buf.length - offset < headerLen + maskLen + len) break; // 整帧未到齐，等续传
    const maskStart = offset + headerLen;
    const payloadStart = maskStart + maskLen;
    const payload = buf.subarray(payloadStart, payloadStart + len);
    if (masked) {
      const mask = buf.subarray(maskStart, maskStart + 4);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    }
    offset = payloadStart + len;

    if (opcode === 0x8) { client.socket.end(); client.recvBuffer = null; return; } // close
    if (opcode === 0x9) { sendFrame(client, 0xA, Buffer.from(payload)); continue; } // ping -> pong
    if (opcode === 0xA) { continue; } // pong
    // 文本/二进制（0x1/0x2）与续帧（0x0）：按 FIN 组装后再分发
    if (opcode === 0x0) {
      if (!client.fragments) continue; // 没有进行中的分片，丢弃异常续帧
      client.fragments.push(Buffer.from(payload));
    } else {
      client.fragments = [Buffer.from(payload)];
    }
    if (fin) {
      const full = client.fragments.length === 1 ? client.fragments[0] : Buffer.concat(client.fragments);
      client.fragments = null;
      handleMessage(client, full.toString("utf8"));
    }
  }
  client.recvBuffer = offset >= buf.length ? null : buf.subarray(offset); // 保留未解析残片
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".mp3")) return "audio/mpeg";
  if (filePath.endsWith(".wav")) return "audio/wav";
  if (filePath.endsWith(".ogg")) return "audio/ogg";
  return "application/octet-stream";
}
