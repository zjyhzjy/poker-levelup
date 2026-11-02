// 房间中枢：所有房间状态、消息处理、AI/超时调度都在这里，与传输层无关。
// Node 版（server.js，自己解析 WebSocket 帧）和 Cloudflare 版（worker/index.js，
// 跑在 Durable Object 里）共用同一份逻辑，各自只负责收发文本消息。
//
// 传输层对每条连接调用 connectClient(transport) 拿到 client，收到文本就调
// receiveMessage(client, text)，连接断开调 disconnectClient(client)。transport 只
// 需要提供 send(text) 和 close() 两个方法。
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
  takeoverAiSeat
} from "./game.js";
import { pimcChoosePlayAsync } from "./ai/pimc.js";
import { saveStandings, loadStandings, roomFromStandings, sweepExpiredStandings, setStandingsStore } from "./persistence.js";

const rooms = new Map();
const clients = new Set();
// 搜索型 AI 的 PIMC 预算（按难度档），由传输层按所在平台的算力配置。
let searchOpts = {};

export function configureHub(options = {}) {
  if (options.searchOpts) searchOpts = options.searchOpts;
  if (options.store) setStandingsStore(options.store);
}

// Look up a live room, OR resurrect one from persisted standings (战绩/等级) when it
// isn't in memory — e.g. after a server restart or after the 10-min empty-room sweep.
// The restored room is a between-rounds lobby with levels intact; players reconnect
// by playerId and the host starts the next round. Returns null if no such room exists.
function getOrLoadRoom(code) {
  let room = rooms.get(code);
  if (room) return room;
  const saved = loadStandings(code);
  if (!saved) return null;
  room = roomFromStandings(saved);
  if (!room) return null;
  rooms.set(room.code, room);
  return room;
}
const BID_RESPONSE_TIMEOUT_MS = 10000;
const BURY_TIMEOUT_MS = 120000;

// POST /api/rooms：建一个空房间，返回房间号。
export function createApiRoom(seatCount) {
  const room = createRoom(undefined, { seatCount: Number(seatCount) });
  rooms.set(room.code, room);
  return room.code;
}

// 新连接：先分配临时 playerId（重连时会被客户端保存的 id 覆盖）。
export function connectClient(transport) {
  const client = { transport, playerId: crypto.randomUUID(), roomCode: null, nickname: "" };
  clients.add(client);
  send(client, "hello", { playerId: client.playerId });
  return client;
}

// ── 房间回收：无任何活跃连接持续一段时间的房间从内存清除（并清掉其待触发的
// 托管计时器），防止废弃房间和 POST /api/rooms 刷量造成内存泄漏。
const ROOM_EMPTY_TTL_MS = 10 * 60 * 1000;
const ROOM_SWEEP_MS = 2 * 60 * 1000;
export function startRoomSweeper() {
  return setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      const hasLiveClient = room.clients && room.clients.size > 0;
      if (hasLiveClient) { room.emptySince = null; continue; }
      if (room.emptySince == null) { room.emptySince = now; continue; }
      if (now - room.emptySince > ROOM_EMPTY_TTL_MS) {
        if (room.trusteeTimers) for (const t of Object.values(room.trusteeTimers)) clearTimeout(t);
        if (room.aiTimer) clearTimeout(room.aiTimer);
        rooms.delete(code);
      }
    }
    sweepExpiredStandings(); // drop persisted standings whose snapshot has aged past the TTL
  }, ROOM_SWEEP_MS);
}

export function receiveMessage(client, message) {
  try {
    const { type, payload = {} } = JSON.parse(message);

    // ── Reconnect: client sends their stored playerId ──────────────
    if (type === "reconnect") {
      const storedId = String(payload.playerId || "").trim();
      const code = String(payload.code || "").trim().toUpperCase();
      if (!storedId) throw new Error("无效的玩家ID");
      const room = getOrLoadRoom(code);
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
        evictDuplicateClients(room, storedId, client); // 踢掉同 id 的旧连接
        clearSeatTrusteeTimer(room, seat.index);       // 清掉掉线托管计时，别再误托管已回来的人
        send(client, "hello", { playerId: client.playerId });
        broadcast(room);
        resumeRoomTimers(room); // 恢复可能因无人而停摆的 AI/叫主推进
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
      const room = getOrLoadRoom(code);
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
          evictDuplicateClients(room, storedId, client); // 踢掉同 id 的旧连接
          clearSeatTrusteeTimer(room, seat.index);       // 清掉掉线托管计时
          send(client, "hello", { playerId: client.playerId });
          broadcast(room);
          resumeRoomTimers(room); // 恢复可能因无人而停摆的 AI/叫主推进
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

    // Recommended play — the smallest legal same-suit play. Keep this aligned with
    // human trustee play so the hint button does not suggest a different strategy.
    if (type === "hint") {
      let cardIds = [];
      try { cardIds = recommendPlay(currentRoom(client), client.playerId) || []; } catch { cardIds = []; }
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
    // 6 人叫主：无人亮主时也要有超时兜底，避免真人发呆/掉线把整局卡死。
    if (room.phase === "sixTrump") scheduleSixTrumpTimeout(room);

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

// 同一 playerId 重连/双开页时，房间里可能残留旧的 client 连接（弱网下旧 socket 的
// close/FIN 往往滞后于新连接）。把旧连接踢掉，避免重复 client 累积——否则旧 socket
// 关闭时 disconnect() 会把刚回来的在线玩家误标记为掉线。`keep` 是要保留的新连接。
function evictDuplicateClients(room, playerId, keep) {
  if (!room.clients) return;
  for (const c of [...room.clients]) {
    if (c !== keep && c.playerId === playerId) {
      room.clients.delete(c);
      clients.delete(c);
      try { c.transport.close(); } catch (_) { /* already dead */ }
    }
  }
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
  saveStandings(room); // durably persist 战绩/等级 on every change (signature-gated, best-effort)
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
  for (const c of clients) {
    if (c.roomCode !== room.code) continue;
    const seat = room.seats.find((s) => s.playerId === c.playerId);
    if (!seat || seat.index === vote.initiatorSeat || seat.index === vote.targetSeat) continue;
    try { send(c, "kickVote", payload); } catch (_) { /* dead socket; don't abort the fan-out */ }
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
    for (const c of clients) {
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
      if (room.phase === "sixTrump") scheduleSixTrumpTimeout(room); // 6人叫主无人亮主的超时兜底
      scheduleAi(room);
    }
  }, DEAL_ROUND_MS);
}

// Let each AI seat consider bidding/responding, staggered, once per call. Driven
// by auction events (deal finished, a bid placed, a card revealed) so it respects
// the reveal/response-timeout pacing instead of firing through the fast 350ms AI loop.
function scheduleAiBids(room) {
  // 托管座位（s.trustee，真人挂机/掉线）也要参与抢庄/亮主，用与 AI 相同的
  // decideAiBid / decideAiSixTrump 策略，否则只能靠超时被动 pass，整局偏弱。
  const aiSeats = room.seats.filter((s) => (s.isAi || s.trustee) && s.playerId);
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
          const resp0 = room.bidResponses;
          for (const seat of room.seats) {
            // 一旦 bidResponses 被重置（临时上台/重发）或离开 sixTrump，立即停止——
            // 否则会把后面的座位 pass 进“新一轮”叫主，剥夺其叫主权。
            if (room.phase !== "sixTrump" || room.bidResponses !== resp0) break;
            if (seat.playerId && !room.bidResponses[seat.index]) passSixTrump(room, seat.playerId);
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

// 6 人叫主阶段专用兜底：scheduleBidTimeout 只在“已有人亮主”时才会推进（无 bid 时第
// 一行就 return 了），所以无人亮主、又有真人发呆/掉线时整局会卡死。这里给所有还没响应
// 的座位一个统一的响应窗口，过期就替他们“不亮”，从而触发 _checkAllSixTrumpResponded
// （进扣底 / 临时上台再叫 / 作废重发）。用 sixTrumpTimeoutAt 去重，避免计时器堆叠。
function scheduleSixTrumpTimeout(room) {
  if (room.phase !== "sixTrump" || room.dealing) return;
  if (!room.clients || room.clients.size === 0) return; // 废弃房间不空跑
  const now = Date.now();
  if (room.sixTrumpTimeoutAt && room.sixTrumpTimeoutAt > now) return; // 已在计时
  if (!room.bidResponseReadyAt || room.bidResponseReadyAt <= now) {
    room.bidResponseReadyAt = now + BID_RESPONSE_TIMEOUT_MS;
  }
  const fireAt = room.bidResponseReadyAt + 100;
  room.sixTrumpTimeoutAt = fireAt;
  setTimeout(() => {
    room.sixTrumpTimeoutAt = 0;
    if (room.phase !== "sixTrump" || room.dealing) return;
    if ((room.bidResponseReadyAt || 0) > Date.now()) { scheduleSixTrumpTimeout(room); return; }
    try {
      const resp0 = room.bidResponses;
      for (const seat of room.seats) {
        // bidResponses 被重置（临时上台/重发）或离开 sixTrump 即停，别 pass 进新一轮。
        if (room.phase !== "sixTrump" || room.bidResponses !== resp0) break;
        if (seat.playerId && !room.bidResponses[seat.index]) passSixTrump(room, seat.playerId);
      }
      broadcast(room);
      scheduleAiBids(room);
      scheduleAi(room);
      if (room.phase === "sixTrump") scheduleSixTrumpTimeout(room); // 临时上台后重新叫主则继续兜底
    } catch (_) { /* 状态已推进，忽略 */ }
  }, Math.max(200, fireAt - now));
}

// 重连后恢复可能因“房间一度无人”而停摆的自动推进计时器。scheduleAi 在无连接时会
// 提前 return，所以重连后必须主动重新拉起，否则轮到 AI 时不会再出牌。
function resumeRoomTimers(room) {
  scheduleAi(room);
  scheduleAiBids(room);
  if (room.phase === "sixTrump") scheduleSixTrumpTimeout(room);
  if (room.phase === "burying") scheduleBuryTimeout(room);
  if (room.currentBid) scheduleBidTimeout(room);
}

// 搜索档（强 / 大师）：轮到搜索型 AI 在出牌阶段行动时，用 PIMC
// 搜索选牌而非默认启发式。返回 true 表示已出牌。任何异常都吞掉并返回 false，让外层
// 回退到 runAiStep（即该座位的启发式出牌），保证绝不卡死。搜索是分段异步的：每次采样
// 之间让出事件循环，搜索期间其它房间的消息/计时器照常处理。
async function searchStep(room) {
  if (room.phase !== "playing") return false;
  if ((room.trickPauseUntil || 0) > Date.now()) return false;
  const seatIndex = room.turnSeat;
  const seat = room.seats[seatIndex];
  if (!seat || !seat.isAi) return false;
  const opts = searchOpts[seat.aiLevel];
  if (!opts) return false; // 弱/中：纯启发式，不搜索
  try {
    const cards = await pimcChoosePlayAsync(room, seatIndex, opts);
    // 搜索期间牌局可能已变（踢人/回大厅/换人接管），不再是这个 AI 的回合就作废。
    if (!cards || !cards.length || room.phase !== "playing" || room.turnSeat !== seatIndex || room.seats[seatIndex] !== seat || !seat.isAi) return false;
    playCards(room, seat.playerId, cards.map((c) => c.id));
    return true;
  } catch (_) {
    return false; // 回退到启发式
  }
}

function scheduleAi(room) {
  // 没有任何活跃连接（在座/观战）的废弃房间不再空跑 AI——否则全 AI 房会每 350ms
  // 持续推演+广播直到本局结束，白白占 CPU。重连时由 resumeRoomTimers 重新拉起。
  if (!room.clients || room.clients.size === 0) return;
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
  // 单飞：同一房间最多排一个 AI 行动计时，避免多条 AI 链并存导致节奏叠加、广播扎堆。
  if (room.aiTimer) return;
  room.aiTimer = setTimeout(async () => {
    let moved = false;
    try {
      moved = (await searchStep(room)) || runAiStep(room);
    } catch (error) {
      room.aiTimer = null;
      room.tableLog.push(`AI 操作失败：${error.message}`);
      broadcast(room);
      setTimeout(() => scheduleAi(room), 1500);
      return;
    }
    room.aiTimer = null; // 搜索期间保持占位，避免并发再排一条 AI 链
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
// 清掉某个座位待触发的自动托管计时（重连后调用，避免把已回来的玩家强制托管）。
function clearSeatTrusteeTimer(room, seatIndex) {
  if (room.trusteeTimers && room.trusteeTimers[seatIndex]) {
    clearTimeout(room.trusteeTimers[seatIndex]);
    delete room.trusteeTimers[seatIndex];
  }
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

// 托管座位 isAi=false，算真人；只要还有任何真人座位，房间就保留。
function roomHasHumanSeat(room) {
  return room.seats.some((s) => s.playerId && !s.isAi);
}
// 房间里没有真人座位、也没有任何在线连接 → 全是 AI 的废弃房间，直接关掉并清理计时器。
function maybeCloseAbandonedRoom(room) {
  if (!room || !rooms.has(room.code)) return false;
  const noClients = !room.clients || room.clients.size === 0;
  if (!roomHasHumanSeat(room) && noClients) {
    if (room.trusteeTimers) for (const t of Object.values(room.trusteeTimers)) clearTimeout(t);
      if (room.aiTimer) clearTimeout(room.aiTimer);
    rooms.delete(room.code);
    return true;
  }
  return false;
}

export function disconnectClient(client) {
  clients.delete(client);
  const room = client.roomCode ? rooms.get(client.roomCode) : null;
  if (!room) return;
  room.clients?.delete(client);
  // 只有当房间里没有“另一个仍在线、同一 playerId”的连接时，才把座位标记为掉线。
  // 防止重连竞态 / 双开页：旧 socket 关闭不应把刚回来的在线玩家误判为掉线并触发自动托管。
  const stillConnected = room.clients && [...room.clients].some((c) => c.playerId === client.playerId);
  if (!stillConnected) {
    for (const seat of room.seats) {
      if (seat.playerId === client.playerId) seat.connected = false;
    }
    if (room.spectators.has(client.playerId)) room.spectators.get(client.playerId).connected = false;
  }
  // 最后一个真人退出后只剩 AI（且无连接）→ 关掉这桌 AI 自嗨的废弃房间。
  if (maybeCloseAbandonedRoom(room)) return;
  broadcast(room);
  scheduleAutoTrustee(room); // 掉线的正是当前该行动的人时，启动自动托管计时
}

function send(client, type, payload) {
  client.transport.send(JSON.stringify({ type, payload }));
}
