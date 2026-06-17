import crypto from "node:crypto";
import { cardScore, createDeck, levelAdvance, LEVEL_RANKS, rankNumber, RANKS, shuffle, SUITS } from "./cards.js";
import * as classic4Mode from "./rules/classic4.js";
import * as findFriend5Mode from "./rules/findFriend5.js";
import * as fixedTeam6Mode from "./rules/fixedTeam6.js";

const DEFAULT_SEATS = 5;
const BID_RESPONSE_TIMEOUT_MS = 10000;
const MODES = {
  FIND_FRIEND_5: "findFriend5",
  FIXED_TEAM_6: "fixedTeam6",
  CLASSIC_4: "classic4"
};
const MODE_CONFIG = {
  [MODES.FIND_FRIEND_5]: findFriend5Mode.findFriend5Rules,
  [MODES.FIXED_TEAM_6]: fixedTeam6Mode.fixedTeam6Rules,
  [MODES.CLASSIC_4]: classic4Mode.classic4Rules
};

function modeFromOptions(options = {}) {
  if (options.mode && MODE_CONFIG[options.mode]) return options.mode;
  if (options.seatCount === 4) return MODES.CLASSIC_4;
  if (options.seatCount === 6) return MODES.FIXED_TEAM_6;
  return MODES.FIND_FRIEND_5;
}

function modeConfig(roomOrMode) {
  const mode = typeof roomOrMode === "string" ? roomOrMode : (roomOrMode.mode || MODES.FIND_FRIEND_5);
  return MODE_CONFIG[mode] || MODE_CONFIG[MODES.FIND_FRIEND_5];
}

function isClassic4(room) { return room.mode === MODES.CLASSIC_4; }
function isFixedTeamMode(room) { return modeConfig(room).fixedTeams === true; }
function hasFriendMode(room) { return modeConfig(room).hasFriend === true; }
function modeRules(room) {
  if (room.mode === MODES.CLASSIC_4) return classic4Mode;
  if (room.mode === MODES.FIXED_TEAM_6) return fixedTeam6Mode;
  return findFriend5Mode;
}
const PHASES = {
  LOBBY: "lobby",
  DEALING: "dealing",
  AUCTION_READY: "auctionReady",
  AUCTION: "auction",
  FORCED_SUIT: "forcedSuit",
  SIX_TRUMP: "sixTrump",
  BURYING: "burying",
  FRIEND: "friend",
  PLAYING: "playing",
  ROUND_OVER: "roundOver"
};

function uid(prefix = "id") {
  return `${prefix}_${crypto.randomBytes(5).toString("hex")}`;
}

function emptySeats(seatCount) {
  return Array.from({ length: seatCount }, (_, index) => ({
    index,
    playerId: null,
    nickname: "",
    avatar: null,
    level: null,
    hand: [],
    connected: false,
    isAi: false,
    aiLevel: null,
    trustee: false,
    takenTrickPoints: 0
  }));
}

export function createRoom(code = randomRoomCode(), options = {}) {
  const mode = modeFromOptions(options);
  const config = modeConfig(mode);
  const seatCount = config.seatCount || DEFAULT_SEATS;
  return {
    code,
    mode,
    seatCount,
    deckCopies: config.deckCopies,
    kittySize: config.kittySize,
    fixedTeams: config.fixedTeams, // 固定隔座队：4 人 {0,2}/{1,3}；6 人 {0,2,4}/{1,3,5}
    phase: PHASES.LOBBY,
    seats: emptySeats(seatCount),
    spectators: new Map(),
    hostId: null,
    round: 0,
    starterSeat: null,
    firstLevel: null,
    levelRank: null,
    trumpSuit: null,
    noTrump: false,
    dealerSeat: null,
    currentBid: null,
    seatBids: {},       // seatIndex -> bid object (for display beside seats)
    bidResponses: {},   // seatIndex -> "bid" | "pass" (tracking who responded)
    sixTrumpAttempt: 0, // 6 人叫主：0=原庄家队，1=另一队上台后再叫
    sixOriginalDealerSeat: null,
    sixFirstAuction: false,
    dealing: false,     // true while cards are being dealt round-by-round
    dealCursor: null,   // next seat to receive a card during gradual dealing
    deck: [],
    kitty: [],
    revealedKitty: [],
    forceSpin: null,
    friendCall: null,
    friendSeat: null,
    hiddenKitty: [],
    currentLeader: null,
    turnSeat: null,
    currentTrick: [],
    lastTrick: [],
    throwResult: null,   // { seat, allCards, keepCards, failed, message } — cleared after next play
    autoFinishLastTrick: false,
    trickPauseUntil: 0,
    finishedTricks: [],
    tableLog: [],
    scores: { attackers: 0, dealerTeam: 0 },
    throwPenaltyStats: { attackers: 0, dealerTeam: 0, netToAttackers: 0 },
    seatPersonalScores: {},  // seatIndex -> number (pre-friend-reveal personal scores)
    lastResult: null
  };
}

export function randomRoomCode() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

// 昵称清洗：去空白并按字符限长 16，防止超长昵称撑爆状态/UI。
// HTML 转义在前端渲染时统一处理（见 app.js 的 seatName/escapeHtml）。
function sanitizeNickname(s) {
  return typeof s === "string" ? [...s.trim()].slice(0, 16).join("") : "";
}

function sanitizeAvatar(s) {
  if (typeof s !== "string") return null;
  const avatar = s.trim();
  if (!avatar) return null;
  const imageMatch = avatar.match(/^img:avatars\/([^/\\]+)\.(png|jpe?g|gif|webp|svg)$/i);
  if (imageMatch && !imageMatch[1].includes("..")) {
    return avatar.slice(0, 200);
  }
  return [...avatar].slice(0, 8).join("");
}

export function joinRoom(room, playerId, nickname) {
  if (!room.hostId) room.hostId = playerId;
  room.spectators.set(playerId, { playerId, nickname: sanitizeNickname(nickname) || "游客", connected: true });
  return publicState(room, playerId);
}

export function sit(room, playerId, seatIndex, nickname, avatar) {
  assertPhase(room, PHASES.LOBBY);
  const seat = room.seats[seatIndex];
  if (!seat) throw new Error("座位不存在");
  if (seat.playerId && seat.playerId !== playerId) throw new Error("这个座位已经有人了");
  for (const other of room.seats) {
    if (other.playerId === playerId) {
      other.playerId = null;
      other.nickname = "";
      other.avatar = null;
      other.connected = false;
    }
  }
  seat.playerId = playerId;
  seat.nickname = sanitizeNickname(nickname) || room.spectators.get(playerId)?.nickname || `玩家${seatIndex + 1}`;
  seat.avatar = sanitizeAvatar(avatar);
  seat.connected = true;
  seat.isAi = false;
  seat.trustee = false;
  room.spectators.delete(playerId);
}

export function takeoverAiSeat(room, playerId, seatIndex, nickname, avatar) {
  const existingSeat = findSeatByPlayer(room, playerId);
  if (existingSeat) throw new Error("你已经入座了");
  const seat = room.seats[seatIndex];
  if (!seat) throw new Error("座位不存在");
  if (!seat.isAi || !seat.playerId) throw new Error("只能接管 AI 座位");
  seat.playerId = playerId;
  seat.nickname = sanitizeNickname(nickname) || room.spectators.get(playerId)?.nickname || `玩家${seatIndex + 1}`;
  seat.avatar = sanitizeAvatar(avatar);
  seat.connected = true;
  seat.isAi = false;
  seat.aiLevel = null;
  seat.aiWeights = undefined;
  seat.trustee = false;
  room.spectators.delete(playerId);
  room.tableLog.push(`${seat.nickname} 接管了座位 ${seatIndex + 1} 的 AI，继续本局。`);
}

export function addAiPlayer(room, seatIndex, aiLevel = "medium") {
  assertPhase(room, PHASES.LOBBY);
  const seat = room.seats[seatIndex];
  if (!seat) throw new Error("座位不存在");
  if (seat.playerId) throw new Error("这个座位已经有人了");
  const level = AI_PROFILES[aiLevel] ? aiLevel : "medium";
  const tag = { easy: "弱", medium: "中", hard: "强", master: "大师" }[level];
  seat.playerId = uid("ai");
  seat.nickname = `AI${seatIndex + 1}·${tag}`;
  seat.avatar = "🤖";
  seat.connected = true;
  seat.isAi = true;
  seat.aiLevel = level;
  seat.aiRngState = (Math.random() * 2 ** 31) | 0; // per-seat randomness
  seat.aiBias = Math.random() - 0.5;               // stable personality (-0.5..0.5)
}

export function leaveSeat(room, playerId) {
  assertPhase(room, PHASES.LOBBY);
  const seat = findSeatByPlayer(room, playerId);
  if (!seat) return;
  room.spectators.set(playerId, { playerId, nickname: seat.nickname, connected: true });
  seat.playerId = null;
  seat.nickname = "";
  seat.avatar = null;
  seat.connected = false;
  seat.isAi = false;
  seat.trustee = false;
}

// 踢掉某个 AI，腾出座位让真人坐下。只能在大厅（开局前）操作，且只能踢 AI——
// 这样朋友来了可以替掉一个 AI。座位变空后，对方用 sit 坐下即可。
export function kickAi(room, seatIndex) {
  assertPhase(room, PHASES.LOBBY);
  const seat = room.seats[seatIndex];
  if (!seat) throw new Error("座位不存在");
  if (!seat.isAi) throw new Error("只能踢 AI");
  clearSeatForKick(room, seatIndex, { toSpectator: false });
}

export function kickSeatByVote(room, seatIndex) {
  const seat = room.seats[seatIndex];
  if (!seat || !seat.playerId) throw new Error("目标座位不存在");
  if (room.phase === PHASES.LOBBY) {
    clearSeatForKick(room, seatIndex, { toSpectator: true });
    return;
  }
  if (seat.isAi) throw new Error("牌局中不能移除 AI 座位");
  seat.playerId = uid("ai");
  seat.nickname = `AI替补${seatIndex + 1}`;
  seat.avatar = "🤖";
  seat.connected = true;
  seat.isAi = true;
  seat.aiLevel = seat.aiLevel || "medium";
  seat.aiRngState = (Math.random() * 2 ** 31) | 0;
  seat.aiBias = Math.random() - 0.5;
  seat.trustee = false;
}

function clearSeatForKick(room, seatIndex, { toSpectator }) {
  const seat = room.seats[seatIndex];
  if (!seat) throw new Error("座位不存在");
  if (toSpectator && seat.playerId && !seat.isAi) {
    room.spectators.set(seat.playerId, { playerId: seat.playerId, nickname: seat.nickname, connected: true });
  }
  seat.playerId = null;
  seat.nickname = "";
  seat.avatar = null;
  seat.connected = false;
  seat.isAi = false;
  seat.aiLevel = null;
  seat.trustee = false;
  seat.aiWeights = undefined;
}

export function startRound(room, random = Math.random, options = {}) {
  // options.deal === false → set up the round but deal cards gradually via
  // dealRound() (driven by a timer in server.js). Default deals everything at
  // once so unit tests and any non-animated callers keep working.
  const dealImmediately = options.deal !== false;
  assertPhase(room, PHASES.LOBBY);
  if (room.seats.some((seat) => !seat.playerId)) throw new Error(`需要 ${room.seatCount} 名玩家全部坐下`);
  room.round += 1;
  const firstRound = room.round === 1;
  room.trumpSuit = null;
  room.noTrump = false;
  if (isFixedTeamMode(room)) {
    // 固定队：首轮先抢庄；之后按上局结果确定本轮庄家。
    if (firstRound) { room.teamLevels = { 0: "2", 1: "2" }; room.nextDealerSeat = null; }
    room.dealerSeat = room.nextDealerSeat ?? null;
    room.levelRank = room.dealerSeat === null ? "2" : room.teamLevels[room.dealerSeat % 2];
    room.sixOriginalDealerSeat = room.dealerSeat;
    room.sixTrumpAttempt = 0;
    room.sixFirstAuction = firstRound;
  } else {
    // 5 人：抢庄定庄，个人等级。
    const level = firstRound ? LEVEL_RANKS[Math.floor(random() * LEVEL_RANKS.length)] : null;
    room.firstLevel = room.firstLevel ?? level;
    room.levelRank = null;
    room.dealerSeat = null;
  }
  room.currentBid = null;
  room.seatBids = {};
  room.bidResponses = {};
  room.revealedKitty = [];
  room.forceSpin = null;
  room.friendCall = null;
  room.friendSeat = null;
  room.hiddenKitty = [];
  room.currentTrick = [];
  room.lastTrick = [];
  room.lastTrickWin = null;
  room.autoFinishLastTrick = false;
  room.trickPauseUntil = 0;
  room.friendReveal = null;
  room.throwResult = null;
  room.finishedTricks = [];
  room.scores = { attackers: 0, dealerTeam: 0 };
  room.throwPenaltyStats = { attackers: 0, dealerTeam: 0, netToAttackers: 0 };
  room.seatPersonalScores = {};
  room.lastResult = null;
  room.tableLog = [];
  room.kitty = [];
  room.deck = shuffle(createDeck(modeConfig(room).deckCopies), random);
  room.phase = PHASES.DEALING;
  room.starterSeat = isFixedTeamMode(room)
    ? (room.dealerSeat ?? Math.floor(random() * room.seatCount))
    : (firstRound ? Math.floor(random() * room.seatCount) : nextSeat(room.starterSeat, room.seatCount));
  room.currentLeader = room.starterSeat;
  room.turnSeat = room.starterSeat;
  for (const seat of room.seats) {
    seat.hand = [];
    seat.takenTrickPoints = 0;
    seat.lockedTriples = []; // 本局内被“锁定”的三条（不可再拆成对子出）
    if (isFixedTeamMode(room)) seat.level = room.teamLevels[seat.index % 2]; // 固定队=所属队共享等级
    else if (firstRound) seat.level = room.firstLevel;
  }

  room.tableLog.push(`本轮从 ${seatName(room, room.starterSeat)} 开始逆时针摸牌。`);
  room.tableLog.push(isFixedTeamMode(room)
    ? `【系统】本局游戏开始！${room.seatCount} 人固定队发完牌后叫主${room.dealerSeat === null ? "抢庄" : "，庄家不变"}。`
    : `【系统】本局游戏开始！请在摸牌期间亮主抢庄。`);

  room.dealing = true;
  room.dealCursor = room.starterSeat;
  if (dealImmediately) {
    while (dealRound(room)) { /* deal all rounds at once */ }
  }
}

// Deal one "圈" (one card to each seated position, counter-clockwise from the
// starter). Returns true if more cards remain to be dealt, false when finished.
export function dealRound(room) {
  if (room.phase !== PHASES.DEALING || !room.dealing) return false;
  for (let i = 0; i < room.seatCount && room.deck.length > room.kittySize; i += 1) {
    const card = room.deck.shift();
    room.seats[room.dealCursor].hand.push(card);
    room.dealCursor = nextSeat(room.dealCursor, room.seatCount);
  }
  for (const seat of room.seats) sortSeatHandForRound(room, seat);
  if (room.deck.length <= room.kittySize) {
    room.kitty = room.deck.splice(0);
    finishDealing(room);
    return false;
  }
  return true;
}

function finishDealing(room) {
  room.dealing = false;
  room.dealCursor = null;
  if (room.currentBid) {
    // Someone bid during the deal. Once everyone has a complete hand, earlier
    // pass responses no longer count; players must react again with full info.
    room.phase = isFixedTeamMode(room) ? PHASES.SIX_TRUMP : PHASES.AUCTION_READY;
    room.bidResponses = { [room.currentBid.seat]: "bid" };
    room.bidResponseReadyAt = Date.now() + BID_RESPONSE_TIMEOUT_MS;
    room.tableLog.push(isFixedTeamMode(room) ? "摸牌结束，请其他玩家确认是否继续亮主。" : "摸牌结束，请其他玩家确认是否继续抢庄。");
    return;
  }
  if (room.phase === PHASES.DEALING) {
    if (isFixedTeamMode(room)) {
      startSixTrumpCalling(room);
    } else {
      room.phase = PHASES.AUCTION_READY;
      room.tableLog.push("摸牌结束无人亮主，等待手动开始翻底拍卖。");
    }
  }
}

export function makeBid(room, playerId, cardIds) {
  if (![PHASES.DEALING, PHASES.AUCTION_READY, PHASES.AUCTION, PHASES.FORCED_SUIT].includes(room.phase)) throw new Error("现在不能抢庄");
  const seat = findSeatByPlayer(room, playerId);
  if (!seat) throw new Error("请先入座");
  const forcedSuitBid = room.phase === PHASES.FORCED_SUIT;
  const fixedTeamBid = isFixedTeamMode(room) && [PHASES.DEALING, PHASES.AUCTION_READY, PHASES.FORCED_SUIT].includes(room.phase);
  const fixedOpeningAuction = fixedTeamBid && fixedTeam6Mode.isSixOpeningAuction(room);
  if (forcedSuitBid && forceSpinCountdownActive(room)) throw new Error("翻底轮盘倒计时中，请稍候");
  if (forcedSuitBid && seat.index === room.dealerSeat) throw new Error("强制庄家请直接确认主花色");
  const cards = pickCards(seat.hand, cardIds);
  const fixedLevelRank = fixedOpeningAuction && room.dealerSeat === null ? seat.level : room.levelRank;
  const bid = fixedTeamBid
    ? evaluateFixedTeamTrumpCall(room, cards, fixedLevelRank)
    : evaluateBid(cards, seat.level);
  if (!bid) {
    throw new Error(fixedTeamBid
      ? (isClassic4(room) ? `只能亮当前等级 ${fixedLevelRank} 的同花色牌，或选择至少 2 张王亮无主` : `只能亮当前等级 ${fixedLevelRank} 的同花色牌，或选择 3 张王亮无主`)
      : "只能亮自己的常主牌，或任意 3 张王");
  }
  if (room.currentBid && compareBid(bid, room.currentBid) <= 0) throw new Error("必须用更高强度抢庄");
  room.currentBid = { ...bid, seat: seat.index, playerId, cards };
  // 盖庄后其他座位需对更高的庄重新表态：清空旧的亮牌与响应，只保留本次亮庄者。
  // 否则 _checkAllBidResponded 会把陈旧的 pass/bid 计入而提前定庄，跳过被盖者再抢。
  room.seatBids = { [seat.index]: { ...bid, cards } };
  room.bidResponses = { [seat.index]: "bid" };
  if (!room.dealing) room.bidResponseReadyAt = Date.now() + BID_RESPONSE_TIMEOUT_MS;
  if (!fixedTeamBid || room.dealerSeat === null || fixedOpeningAuction) {
    room.dealerSeat = seat.index;
    room.levelRank = bid.levelRank;
    if (fixedTeamBid) {
      room.sixOriginalDealerSeat = seat.index;
      room.starterSeat = seat.index;
      room.currentLeader = seat.index;
      room.turnSeat = seat.index;
    }
  }
  room.noTrump = bid.noTrump;
  room.trumpSuit = bid.trumpSuit;
  if (!room.dealing && !hasFriendMode(room)) {
    for (const s of room.seats) sortHand(s.hand, room);
  }
  room.tableLog.push(`${seat.nickname} ${fixedTeamBid ? "亮主" : "亮庄"}：${cards.map((c) => c.label).join("、")}`);
  if (forcedSuitBid) {
    // 翻底后开放亮主：盖庄者成为新庄家（makeBid 上方已把 dealerSeat 指向他），
    // 但不立即定庄——给其他人一个盖更高/不亮的响应窗口，全部表态后才确定庄家。
    room.forceSpin = null;
    _openForcedResponseWindow(room);
    return;
  }
  // Never confirm immediately — always let broadcast fire first so the bid card
  // is visible on the table. confirmDealer will be triggered by _checkAllBidResponded
  // once everyone has responded, or by scheduleBidTimeout after the response window.
  _checkAllBidResponded(room);
}

export function passBid(room, playerId) {
  if (![PHASES.DEALING, PHASES.AUCTION_READY, PHASES.AUCTION, PHASES.FORCED_SUIT].includes(room.phase)) throw new Error("现在不能操作");
  if (room.phase === PHASES.FORCED_SUIT && forceSpinCountdownActive(room)) throw new Error("翻底轮盘倒计时中，请稍候");
  if (!room.currentBid) throw new Error("还没有人亮庄，无需操作");
  const seat = findSeatByPlayer(room, playerId);
  if (!seat) throw new Error("请先入座");
  if (room.bidResponses[seat.index]) throw new Error("你已经响应过了");
  room.bidResponses[seat.index] = "pass";
  room.tableLog.push(`${seat.nickname} 不亮。`);
  _checkAllBidResponded(room);
}

function _checkAllBidResponded(room) {
  if (!room.currentBid) return;
  if (room.dealing) return; // wait until all cards are dealt before confirming
  const totalSeats = room.seats.filter((s) => s.playerId).length;
  const responded = Object.keys(room.bidResponses).length;
  if (responded >= totalSeats) {
    if (room.phase === PHASES.FORCED_SUIT && isFixedTeamMode(room)) {
      room.forceSpin = null;
      room.levelRank = room.currentBid.levelRank;
      room.trumpSuit = room.currentBid.trumpSuit;
      room.noTrump = room.currentBid.noTrump;
      giveKittyToDealer(room);
      return;
    }
    confirmDealer(room);
  }
}

function startSixTrumpCalling(room) {
  room.phase = PHASES.SIX_TRUMP;
  room.currentBid = null;
  room.seatBids = {};
  room.bidResponses = {};
  room.trumpSuit = null;
  room.noTrump = false;
  for (const seat of room.seats) sortHand(seat.hand, room);
  if (room.dealerSeat === null) {
    room.tableLog.push(`首轮抢庄：所有人可亮自己的 ${room.levelRank} 定主，亮主者坐庄。`);
  } else {
    room.tableLog.push(`${seatName(room, room.dealerSeat)} 坐庄（打 ${room.levelRank}），所有人可亮 ${room.levelRank} 定主，庄家不变。`);
  }
}

function evaluateFixedTeamTrumpCall(room, cards, levelRank) {
  return isClassic4(room)
    ? classic4Mode.evaluateClassic4TrumpCall(cards, levelRank)
    : fixedTeam6Mode.evaluateFixedTeam6TrumpCall(cards, levelRank);
}

export function callSixTrump(room, playerId, cardIds) {
  assertPhase(room, PHASES.SIX_TRUMP);
  const seat = findSeatByPlayer(room, playerId);
  if (!seat) throw new Error("请先入座");
  if (room.bidResponses[seat.index]) throw new Error("你已经响应过了");
  const openingAuction = fixedTeam6Mode.isSixOpeningAuction(room);
  const levelRank = openingAuction ? seat.level : room.levelRank;
  const cards = pickCards(seat.hand, cardIds);
  const bid = evaluateFixedTeamTrumpCall(room, cards, levelRank);
  if (!bid) throw new Error(isClassic4(room) ? `只能亮当前等级 ${levelRank} 的同花色牌，或选择至少 2 张王亮无主` : `只能亮当前等级 ${levelRank} 的同花色牌，或选择 3 张王亮无主`);
  if (room.currentBid && compareBid(bid, room.currentBid) <= 0) throw new Error("必须用更高强度盖主");

  if (openingAuction || room.dealerSeat === null) {
    room.dealerSeat = seat.index;
    room.sixOriginalDealerSeat = seat.index;
    room.levelRank = room.teamLevels[seat.index % 2];
    room.starterSeat = seat.index;
    room.currentLeader = seat.index;
    room.turnSeat = seat.index;
    for (const s of room.seats) s.level = room.teamLevels[s.index % 2];
  }

  room.currentBid = { ...bid, seat: seat.index, playerId, cards };
  room.seatBids = { [seat.index]: { ...bid, cards } };
  room.bidResponses = { [seat.index]: "bid" };
  if (!room.dealing) room.bidResponseReadyAt = Date.now() + BID_RESPONSE_TIMEOUT_MS;
  room.trumpSuit = bid.trumpSuit;
  room.noTrump = bid.noTrump === true;
  room.tableLog.push(`${seat.nickname} 亮主：${cards.map((c) => c.label).join("、")}${room.dealerSeat === seat.index ? "，坐庄" : ""}`);
  _checkAllSixTrumpResponded(room);
}

export function passSixTrump(room, playerId) {
  assertPhase(room, PHASES.SIX_TRUMP);
  const seat = findSeatByPlayer(room, playerId);
  if (!seat) throw new Error("请先入座");
  if (room.bidResponses[seat.index]) throw new Error("你已经响应过了");
  room.bidResponses[seat.index] = "pass";
  room.tableLog.push(`${seat.nickname} 不亮。`);
  _checkAllSixTrumpResponded(room);
}

function _checkAllSixTrumpResponded(room) {
  if (room.dealing) return;
  const totalSeats = room.seats.filter((s) => s.playerId).length;
  const responded = Object.keys(room.bidResponses).length;
  if (responded < totalSeats) return;
  if (room.currentBid) {
    room.sixFirstAuction = false;
    giveKittyToDealer(room);
  } else {
    handleNoSixTrumpCall(room);
  }
}

function handleNoSixTrumpCall(room) {
  if (room.dealerSeat === null) {
    room.tableLog.push("首轮无人亮主，本轮作废，重新发牌后继续抢庄。");
    redealSixSameRound(room, null);
    return;
  }
  if (room.sixTrumpAttempt === 0) {
    const original = room.sixOriginalDealerSeat ?? room.dealerSeat;
    const newDealer = nextSeat(original, room.seatCount);
    room.dealerSeat = newDealer;
    room.levelRank = room.teamLevels[newDealer % 2];
    room.sixTrumpAttempt = 1;
    room.currentBid = null;
    room.seatBids = {};
    room.bidResponses = {};
    room.trumpSuit = null;
    room.noTrump = false;
    room.sixFirstAuction = false;
    for (const seat of room.seats) {
      seat.level = room.teamLevels[seat.index % 2];
      sortHand(seat.hand, room);
    }
    room.tableLog.push(`原庄家队无人亮主，${seatName(room, newDealer)} 所在队临时上台（打 ${room.levelRank}），重新叫主。`);
    return;
  }
  const original = room.sixOriginalDealerSeat ?? room.dealerSeat;
  room.tableLog.push("两队均无人亮主，本轮作废，庄家不变重新发牌。");
  redealSixSameRound(room, original);
}

function redealSixSameRound(room, dealerSeat) {
  room.dealerSeat = dealerSeat;
  room.sixOriginalDealerSeat = dealerSeat;
  room.sixTrumpAttempt = 0;
  room.sixFirstAuction = dealerSeat === null;
  room.levelRank = dealerSeat === null ? "2" : room.teamLevels[dealerSeat % 2];
  room.currentBid = null;
  room.seatBids = {};
  room.bidResponses = {};
  room.revealedKitty = [];
  room.forceSpin = null;
  room.friendCall = null;
  room.friendSeat = null;
  room.hiddenKitty = [];
  room.currentTrick = [];
  room.lastTrick = [];
  room.lastTrickWin = null;
  room.autoFinishLastTrick = false;
  room.friendReveal = null;
  room.throwResult = null;
  room.finishedTricks = [];
  room.scores = { attackers: 0, dealerTeam: 0 };
  room.throwPenaltyStats = { attackers: 0, dealerTeam: 0, netToAttackers: 0 };
  room.seatPersonalScores = {};
  room.lastResult = null;
  room.kitty = [];
  room.deck = shuffle(createDeck(modeConfig(room).deckCopies), Math.random);
  room.starterSeat = dealerSeat ?? Math.floor(Math.random() * room.seatCount);
  room.currentLeader = room.starterSeat;
  room.turnSeat = room.starterSeat;
  for (const seat of room.seats) {
    seat.hand = [];
    seat.takenTrickPoints = 0;
    seat.lockedTriples = [];
    seat.level = room.teamLevels[seat.index % 2];
  }
  room.phase = PHASES.DEALING;
  room.dealing = true;
  room.dealCursor = room.starterSeat;
  while (dealRound(room)) { /* redeal immediately after void round */ }
}

export function startAuction(room) {
  assertPhase(room, PHASES.AUCTION_READY);
  if (room.currentBid) return confirmDealer(room);
  room.phase = PHASES.AUCTION;
  room.tableLog.push("开始翻底拍卖，请一张一张翻开底牌。");
}

export function revealKittyCard(room) {
  assertPhase(room, PHASES.AUCTION);
  if (room.currentBid) return confirmDealer(room);
  const card = room.kitty[room.revealedKitty.length];
  if (!card) throw new Error("没有可翻的底牌");
  room.revealedKitty.push(card);
  room.tableLog.push(`翻底：${card.label}`);
  if (room.revealedKitty.length === room.kittySize) {
    forceDealer(room, card);
  }
}

export function confirmDealer(room) {
  if (!room.currentBid) throw new Error("还没有庄家");
  // 幂等：仅抢庄阶段可确认。giveKittyToDealer 后 phase 进入 burying，重复调用
  // 会再次把底牌并入庄家手牌、破坏牌堆完整性，故非抢庄阶段直接早退。
  if (![PHASES.DEALING, PHASES.AUCTION_READY, PHASES.AUCTION, PHASES.FORCED_SUIT].includes(room.phase)) return;
  if (room.dealing) return; // cards still being dealt; kitty not ready yet
  room.forceSpin = null;
  room.dealerSeat = room.currentBid.seat;
  room.levelRank = room.currentBid.levelRank;
  room.trumpSuit = room.currentBid.trumpSuit;
  room.noTrump = room.currentBid.noTrump;
  giveKittyToDealer(room);
}

export function forceDealer(room, lastKittyCard) {
  // 从第一个摸牌玩家(starterSeat)开始，按逆时针(nextSeat，与摸牌/出牌方向一致)数人。
  // 点数映射位置：王=0、A=1（都停在 starterSeat 自己）、2=第2个、… K=13。
  const { seatIndex, count } = findFriend5Mode.forcedDealerTargetSeat(room.starterSeat, room.seatCount, lastKittyCard);
  const dealer = room.seats[seatIndex];
  room.dealerSeat = seatIndex;
  room.levelRank = dealer.level;
  // Jokers force noTrump; otherwise default to last kitty card's suit
  const isJoker = lastKittyCard.suit === "joker";
  room.noTrump = isJoker;
  room.trumpSuit = isJoker ? null : lastKittyCard.suit;
  room.currentBid = { seat: seatIndex, playerId: dealer.playerId, strength: 0, levelRank: dealer.level, trumpSuit: room.trumpSuit, noTrump: room.noTrump, cards: [lastKittyCard] };
  // 不把翻出的最后一张底牌塞进 seatBids：否则它会显示在被迫坐庄者头顶，像是他“亮”的
  // 花色牌，造成误解。这张牌仍保留在 currentBid（内部用）、forceSpin.card（中央轮盘
  // 面板）和 revealedKitty（河牌上方）里。
  room.seatBids = {};
  room.bidResponses = {};
  room.forceSpin = findFriend5Mode.buildForceSpin(room.starterSeat, seatIndex, count, lastKittyCard);
  room.phase = PHASES.FORCED_SUIT;
  room.tableLog.push(`${dealer.nickname} 被强制坐庄，可选择是否亮自己的常主花色改主。`);
  for (const seat of room.seats) {
    sortHand(seat.hand, room, hasFriendMode(room) ? seat.level : null);
  }
}

function forceSpinCountdownActive(room) {
  return findFriend5Mode.forceSpinCountdownActive(room.forceSpin);
}

function prevSeat(index, seatCount) {
  return (index + seatCount - 1) % seatCount;
}

// 翻底轮盘落定后开放亮主：强制庄家先决定（亮自己的常主 / 亮无主 / 不亮沿用底牌花色），
// 任何一种都不立即定庄，而是开一个响应窗口让其他人盖更高或不亮，全部表态后才确定庄家。
function _openForcedResponseWindow(room) {
  if (!room.dealing) room.bidResponseReadyAt = Date.now() + BID_RESPONSE_TIMEOUT_MS;
  _checkAllBidResponded(room);
}

export function chooseForcedTrump(room, playerId, suit = null, options = {}) {
  assertPhase(room, PHASES.FORCED_SUIT);
  if (forceSpinCountdownActive(room)) throw new Error("翻底轮盘倒计时中，请稍候");
  const dealer = findSeatByPlayer(room, playerId);
  if (!dealer || dealer.index !== room.dealerSeat) throw new Error("只有强制庄家可以定主花色");
  room.forceSpin = null;
  if (options.noTrump) {
    const cards = pickCards(dealer.hand, options.cardIds || []);
    if (cards.length !== 3 || !cards.every((card) => card.suit === "joker")) throw new Error("亮无主需要选择 3 张王");
    room.noTrump = true;
    room.trumpSuit = null;
    room.currentBid = { seat: dealer.index, playerId, strength: cards.length, levelRank: room.levelRank, trumpSuit: null, noTrump: true, cards };
    // 强制庄主动亮无主：当成一次真实亮主，挂到庄家座位旁（亮几张显示几张）。
    room.seatBids = { [dealer.index]: { noTrump: true, trumpSuit: null, levelRank: room.levelRank, strength: cards.length, cards } };
    room.bidResponses = { [dealer.index]: "bid" };
    if (!hasFriendMode(room)) sortHand(dealer.hand, room);
    room.tableLog.push(`${dealer.nickname} 亮 3 张王，定为无主。`);
    _openForcedResponseWindow(room);
    return;
  }
  if (suit && !SUITS.includes(suit)) throw new Error("花色不存在");
  if (suit) {
    const hasLevelCard = dealer.hand.some((card) => card.rank === room.levelRank && card.suit === suit);
    // 固定队轮庄的庄家由轮转指定（非抢来），有权直接定主，不要求手里有该花色级牌。
    if (!hasLevelCard && !isFixedTeamMode(room)) throw new Error(`你手里没有 ${suit} 的级牌，不能亮此花色`);
    room.trumpSuit = suit;
    room.noTrump = false;
    const revealCards = dealer.hand.filter((card) => card.rank === room.levelRank && card.suit === suit).slice(0, 3);
    room.currentBid = { seat: dealer.index, playerId, strength: revealCards.length, levelRank: room.levelRank, trumpSuit: suit, noTrump: false, cards: revealCards };
    // 强制庄亮自己的常主花色：当成一次真实亮主，挂到庄家座位旁（亮几张显示几张）。
    room.seatBids = { [dealer.index]: { noTrump: false, trumpSuit: suit, levelRank: room.levelRank, strength: revealCards.length, cards: revealCards } };
    room.bidResponses = { [dealer.index]: "bid" };
    if (!hasFriendMode(room)) sortHand(dealer.hand, room);
    room.tableLog.push(`${dealer.nickname} 亮主：${suit}`);
    _openForcedResponseWindow(room);
    return;
  }
  // suit === null：强制庄不亮，沿用底牌花色。保留 forceDealer 设的 strength=0 占位 currentBid，
  // 只把庄家自己标记为已表态（不亮）；其他人仍可亮主抢庄，都不亮则强制庄以底牌花色坐庄。
  room.bidResponses = { ...(room.bidResponses || {}), [dealer.index]: "pass" };
  if (!hasFriendMode(room)) sortHand(dealer.hand, room);
  room.tableLog.push(`${dealer.nickname} 不亮，沿用底牌花色。`);
  _openForcedResponseWindow(room);
}

function giveKittyToDealer(room) {
  const dealer = room.seats[room.dealerSeat];
  dealer.hand.push(...room.kitty);
  // Re-sort all hands now that trump suit is confirmed
  for (const seat of room.seats) sortHand(seat.hand, room);
  room.phase = PHASES.BURYING;
  room.tableLog.push(`${dealer.nickname} 拿起底牌，请扣 ${room.kittySize} 张。`);
}

export function buryKitty(room, playerId, cardIds) {
  assertPhase(room, PHASES.BURYING);
  const dealer = findSeatByPlayer(room, playerId);
  if (!dealer || dealer.index !== room.dealerSeat) throw new Error("只有庄家可以扣底");
  if (cardIds.length !== room.kittySize) throw new Error(`必须扣 ${room.kittySize} 张`);
  const cards = removeCards(dealer.hand, cardIds);
  room.hiddenKitty = cards;
  room.buryTimeoutAt = 0;
  room.buryTimeoutSeat = null;
  sortHand(dealer.hand, room);
  if (!hasFriendMode(room)) {
    // 固定队模式：无需叫朋友，扣底后直接开打。
    room.phase = PHASES.PLAYING;
    room.currentLeader = room.dealerSeat;
    room.turnSeat = room.dealerSeat;
    room.currentTrick = [];
    room.lastTrick = [];
    room.tableLog.push(`${dealer.nickname} 已扣底，开打（隔座为友，固定队）。`);
  } else {
    room.phase = PHASES.FRIEND;
    room.tableLog.push(`${dealer.nickname} 已扣底，等待叫朋友。`);
  }
}

export function callFriend(room, playerId, call) {
  assertPhase(room, PHASES.FRIEND);
  const dealer = findSeatByPlayer(room, playerId);
  if (!dealer || dealer.index !== room.dealerSeat) throw new Error("只有庄家可以叫朋友");
  const ordinal = Number(call.ordinal);
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > 3) throw new Error("第几张必须是 1 到 3");
  const normalized = normalizeCalledCard(call);
  room.friendCall = { ordinal, ...normalized, seen: 0 };
  room.friendSeat = null;
  room.phase = PHASES.PLAYING;
  room.currentLeader = room.dealerSeat;
  room.turnSeat = room.dealerSeat;
  room.currentTrick = [];
  room.lastTrick = [];
  room.tableLog.push(`${dealer.nickname} 叫朋友：第 ${ordinal} 张 ${calledCardLabel(room.friendCall)}`);
}

export function playCards(room, playerId, cardIds) {
  assertPhase(room, PHASES.PLAYING);
  const seat = findSeatByPlayer(room, playerId);
  if (!seat) throw new Error("请先入座");
  if ((room.trickPauseUntil || 0) > Date.now()) throw new Error("上一墩展示中，请稍候");
  if (seat.index !== room.turnSeat) throw new Error("还没轮到你");
  playCardsInternal(room, seat, cardIds);
  autoPlayRestOfLastTrick(room);
}

function playCardsInternal(room, seat, cardIds) {
  const cards = pickCards(seat.hand, cardIds);
  if (!cards.length) throw new Error("请选择要出的牌");
  const leaderPlay = room.currentTrick[0]?.cards ?? null;
  const wasLead = !leaderPlay;

  // Clear previous throwResult whenever a new card is played
  room.throwResult = null;

  const shape = wasLead
    ? analyzeShapeWithLockedTriples(cards, room, seat.lockedTriples || [])
    : analyzeShape(cards, room);
  const isThrow = !leaderPlay && shape.type === "throw";

  if (isThrow) {
    // 甩牌必须是同一门花色（或全部主牌）。混花色甩牌直接拒绝（牌留在手里），
    // 而不是当作"失败甩牌"扣分。
    const throwSuit = playSuit(cards[0], room);
    if (!cards.every((card) => playSuit(card, room) === throwSuit)) {
      throw new Error("甩牌必须是同一门花色（或全部主牌）");
    }
    // Validate throw — may fail if another player has a bigger matching group
    const validation = validateThrow(room, seat, cards);
    // Show all thrown cards on table first regardless
    removeCards(seat.hand, cardIds);
    const play = { seat: seat.index, cards, shape, shapeLabel: describePlayShape(shape, cards), points: cards.reduce((sum, card) => sum + cardScore(card), 0) };

    if (!validation.ok) {
      // Throw failed — find the minimum card to keep, return rest to hand
      const keepCards = findThrowKeepCards(cards, validation.blockedGroup, room);
      const returnCards = cards.filter((c) => !keepCards.some((k) => k.id === c.id));
      // Return non-kept cards to hand
      seat.hand.push(...returnCards);
      sortHand(seat.hand, room);

      // Apply penalty
      _applyThrowPenalty(room, seat.index);

      // Record throw result for display (2s pause handled client-side)
      room.throwResult = {
        seat: seat.index,
        allCards: cards,
        keepCards,
        failed: true,
        message: validation.reason
      };

      // Push only kept cards as the play
      const keepShape = analyzeShapeWithLockedTriples(keepCards, room, seat.lockedTriples || []);
      const keepPlay = { seat: seat.index, cards: keepCards, shape: keepShape, shapeLabel: describePlayShape(keepShape, keepCards), points: keepCards.reduce((sum, card) => sum + cardScore(card), 0) };
      room.currentTrick.push(keepPlay);
      updateFriend(room, keepPlay);
      room.tableLog.push(`${seat.nickname} 甩牌失败（${validation.reason}），仅保留 ${keepCards.map((c) => c.label).join("、")}`);
    } else {
      room.throwResult = { seat: seat.index, allCards: cards, keepCards: cards, failed: false, message: "" };
      room.currentTrick.push(play);
      updateFriend(room, play);
      room.tableLog.push(`${seat.nickname} 甩牌：${cards.map((card) => card.label).join("、")}`);
    }
  } else {
    const validation = validatePlay(room, seat, cards, leaderPlay);
    if (!validation.ok) throw new Error(validation.reason);
    if (leaderPlay) recordTripleLockDecision(room, seat, cards, leaderPlay);
    removeCards(seat.hand, cardIds);
    const playShape = analyzeShapeWithLockedTriples(cards, room, seat.lockedTriples || []);
    const play = { seat: seat.index, cards, shape: playShape, shapeLabel: describePlayShape(playShape, cards), points: cards.reduce((sum, card) => sum + cardScore(card), 0) };
    room.currentTrick.push(play);
    updateFriend(room, play);
    room.tableLog.push(`${seat.nickname} 出牌：${cards.map((card) => card.label).join("、")}`);
  }

  if (room.currentTrick.length === room.seatCount) {
    finishTrick(room);
  } else {
    room.turnSeat = nextSeat(room.turnSeat, room.seatCount);
    if (wasLead && seat.hand.length === 0) {
      room.autoFinishLastTrick = true;
    }
  }
}

function describePlayShape(shape, cards) {
  if (!shape || !cards?.length) return "";
  if (shape.type === "throw" && cards.length > 1 && cards.every((card) => card.rank === cards[0].rank)) {
    const countText = cards.length === 2 ? "两" : cards.length === 3 ? "三" : `${cards.length}`;
    return `${countText}张单${cards[0].rank}`;
  }
  if (shape.type === "single") return "单张";
  if (shape.type === "pair") return "对子";
  if (shape.type === "triple") return "三条";
  if (shape.type === "tractor") return shape.unit === 3 ? "三条拖拉机" : "拖拉机";
  if (shape.type === "throw") return "甩牌";
  return "";
}

function autoPlayRestOfLastTrick(room) {
  while (room.phase === PHASES.PLAYING
    && room.autoFinishLastTrick
    && room.currentTrick.length > 0
    && room.currentTrick.length < room.seatCount) {
    const seat = room.seats[room.turnSeat];
    const leaderCards = room.currentTrick[0]?.cards ?? null;
    if (!seat || !leaderCards || seat.hand.length !== leaderCards.length) break;
    playCardsInternal(room, seat, seat.hand.map((card) => card.id));
  }
  if (room.currentTrick.length === 0 || room.phase !== PHASES.PLAYING) {
    room.autoFinishLastTrick = false;
  }
}

// Find the minimum cards to keep after a failed throw
// Priority: if single lost → keep smallest single; if pair lost → keep smallest pair;
// if both lost → keep smallest single (cheaper penalty)

// Record a -10 penalty for a failed throw against the thrower. The penalty is
// attached to the seat and resolved by team in recomputeScores(), so it works
// correctly whether or not the friend has been revealed yet.
function _applyThrowPenalty(room, throwerSeatIndex) {
  if (room.seatPersonalScores[throwerSeatIndex] === undefined) {
    room.seatPersonalScores[throwerSeatIndex] = 0;
  }
  room.seatPersonalScores[throwerSeatIndex] -= 10;
  room.tableLog.push(`${room.seats[throwerSeatIndex].nickname} 甩牌失败，扣 10 分。`);
  recomputeScores(room);
}

export function runAiStep(room) {
  // Auction phases: timing is fully controlled by scheduleAuctionFlip / scheduleBidTimeout
  // in server.js. AI must NOT self-trigger card reveals or bid responses here,
  // otherwise the paced timers get bypassed instantly.
  if ([PHASES.DEALING, PHASES.AUCTION_READY, PHASES.AUCTION, PHASES.SIX_TRUMP].includes(room.phase)) {
    return false;
  }

  if (room.phase === PHASES.FORCED_SUIT && isAutoSeat(room, room.dealerSeat) && !room.bidResponses[room.dealerSeat]) {
    if (forceSpinCountdownActive(room)) return false;
    const dealer = room.seats[room.dealerSeat];
    chooseForcedTrump(room, dealer.playerId, chooseAiForcedTrump(room, dealer));
    return true;
  }
  if (room.phase === PHASES.BURYING && isAutoSeat(room, room.dealerSeat)) {
    const dealer = room.seats[room.dealerSeat];
    const cards = chooseAiBury(room, dealer).map((card) => card.id);
    buryKitty(room, dealer.playerId, cards);
    return true;
  }
  if (room.phase === PHASES.FRIEND && isAutoSeat(room, room.dealerSeat)) {
    const dealer = room.seats[room.dealerSeat];
    callFriend(room, dealer.playerId, chooseAiFriendCard(room, dealer));
    return true;
  }
  if (room.phase === PHASES.PLAYING && isAutoSeat(room, room.turnSeat)) {
    if ((room.trickPauseUntil || 0) > Date.now()) return false;
    const seat = room.seats[room.turnSeat];
    const leaderCards = room.currentTrick[0]?.cards ?? null;
    const cards = chooseAiPlay(room, seat, leaderCards);
    playCards(room, seat.playerId, cards.map((card) => card.id));
    return true;
  }
  return false;
}

// 托管：把某个真人座位标记为自动行动（由 runAiStep 接管），或取消。
export function setTrustee(room, playerId, on) {
  const seat = room.seats.find((s) => s.playerId === playerId);
  if (!seat) throw new Error("请先入座");
  seat.trustee = !!on;
  if (seat.trustee && seat.aiRngState == null) {
    seat.aiRngState = (Math.random() * 2 ** 31) | 0;
    seat.aiBias = Math.random() - 0.5;
  }
  return seat.trustee;
}

// 推荐出牌：只给“规则内最小组合”，不参与 AI 的赢墩/送分策略。
export function recommendPlay(room, playerId) {
  if (room.phase !== PHASES.PLAYING) return null;
  const seat = room.seats.find((s) => s.playerId === playerId);
  if (!seat || seat.index !== room.turnSeat) return null;
  const leaderCards = room.currentTrick[0]?.cards ?? null;
  const cards = chooseRecommendedPlay(room, seat, leaderCards) || [];
  return cards.map((card) => card.id);
}

function chooseRecommendedPlay(room, seat, leaderCards = null) {
  if (!leaderCards) return [lowestRecommendedCard(seat.hand, room)];
  if (leaderCards.length === 1) {
    const single = chooseRecommendedSingleFollow(room, seat, leaderCards);
    if (single) return single;
  }
  const length = leaderCards.length;
  const noScore = findRecommendedLegalCombination(
    room,
    seat,
    leaderCards,
    length,
    seat.hand.filter((card) => cardScore(card) === 0)
  );
  if (noScore) return noScore;

  const any = findRecommendedLegalCombination(room, seat, leaderCards, length, seat.hand);
  if (any) return any;

  const fallbackCandidates = [
    ...legalCandidatePlays(room, seat, leaderCards),
    legalFollow(room, seat, leaderCards),
    safeAiPlay(room, seat, leaderCards)
  ];
  return bestRecommendedCandidate(room, seat, leaderCards, fallbackCandidates);
}

function chooseRecommendedSingleFollow(room, seat, leaderCards) {
  const ledSuit = playSuit(leaderCards[0], room);
  const sameSuit = seat.hand.filter((card) => playSuit(card, room) === ledSuit);
  const pool = sameSuit.length ? sameSuit : seat.hand;
  const naturalSingles = rankSuitGroups(pool).filter((group) => group.length === 1).map((group) => group[0]);
  const stages = [
    naturalSingles.filter((card) => cardScore(card) === 0),
    pool.filter((card) => cardScore(card) === 0),
    naturalSingles,
    pool
  ];
  for (const stage of stages) {
    const sorted = sortRecommendedCards(stage, room);
    for (const card of sorted) {
      if (validatePlay(room, seat, [card], leaderCards).ok) return [card];
    }
  }
  return null;
}

function findRecommendedLegalCombination(room, seat, leaderCards, length, pool = seat.hand) {
  if (pool.length < length) return null;
  const sorted = sortRecommendedCards(pool, room);
  const combo = [];
  let checked = 0;
  const limit = 120000;
  function search(start) {
    if (checked > limit) return null;
    if (combo.length === length) {
      checked += 1;
      return validatePlay(room, seat, combo, leaderCards).ok ? [...combo] : null;
    }
    const remaining = length - combo.length;
    for (let i = start; i <= sorted.length - remaining; i += 1) {
      combo.push(sorted[i]);
      const found = search(i + 1);
      if (found) return found;
      combo.pop();
    }
    return null;
  }
  return search(0);
}

function bestRecommendedCandidate(room, seat, leaderCards, candidates) {
  const valid = [];
  const seen = new Set();
  for (const cards of candidates) {
    if (!cards || !cards.length) continue;
    if (!validatePlay(room, seat, cards, leaderCards).ok) continue;
    const key = cards.map((card) => card.id).slice().sort().join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    valid.push(cards);
  }
  valid.sort((a, b) => compareRecommendedPlays(a, b, room));
  return valid[0] || [];
}

function compareRecommendedPlays(a, b, room) {
  const scoreA = a.reduce((sum, card) => sum + cardScore(card), 0);
  const scoreB = b.reduce((sum, card) => sum + cardScore(card), 0);
  if (scoreA !== scoreB) return scoreA - scoreB;
  const aa = sortRecommendedCards(a, room);
  const bb = sortRecommendedCards(b, room);
  for (let i = 0; i < Math.min(aa.length, bb.length); i += 1) {
    const diff = compareRecommendedCards(aa[i], bb[i], room);
    if (diff) return diff;
  }
  return aa.length - bb.length;
}

function lowestRecommendedCard(hand, room) {
  return sortRecommendedCards(hand, room)[0];
}

function sortRecommendedCards(cards, room) {
  return [...cards].sort((a, b) => compareRecommendedCards(a, b, room));
}

function compareRecommendedCards(a, b, room) {
  return cardScore(a) - cardScore(b)
    || cardOrderValue(a, room) - cardOrderValue(b, room)
    || String(a.suit).localeCompare(String(b.suit))
    || String(a.id).localeCompare(String(b.id));
}

function rankSuitGroups(cards) {
  const groups = new Map();
  for (const card of cards) {
    const key = `${card.rank}|${card.suit}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(card);
  }
  return [...groups.values()];
}

// ─── AI difficulty profiles ─────────────────────────────────
// Fundamentals — contest tricks, feed a winning partner, cash sure winners, follow
// correctly, protect points — apply to EVERY level (even easy, per the basics every
// player knows). Difficulty = consistency (temperature) + advanced reads:
//   pull        : declarer pulls trump from strength
//   voidDiscard : create voids when discarding / bury to void short suits
//   riskAware   : avoid over-ruff, duck behind a teammate, use known voids
//   temp        : softmax temperature — higher = looser/more mistakes (easy)
export const AI_PROFILES = {
  easy:   { contest: true, feed: true, pull: false, voidDiscard: false, riskAware: false, autoBid: false, bidRatio: 0.62, temp: 1.6  },
  medium: { contest: true, feed: true, pull: true,  voidDiscard: true,  riskAware: false, bidRatio: 0.50, temp: 0.55 },
  hard:   { contest: true, feed: true, pull: true,  voidDiscard: true,  riskAware: true,  bidRatio: 0.42, temp: 0.12 },
  // 大师：叫牌/扣底/亮主等沿用 hard 启发式；出牌阶段由服务端接入 PIMC 搜索
  // （src/ai/pimc.js）逐步推演，强于纯启发式。见 server.js 的 masterStep。
  master: { contest: true, feed: true, pull: true,  voidDiscard: true,  riskAware: true, masterLead: true, bidRatio: 0.42, temp: 0.12 }
};
export function aiProfile(seat) {
  return AI_PROFILES[seat?.aiLevel] || AI_PROFILES.medium;
}

// Tunable scoring weights for the heuristic (scoreFollow / scoreLead). The
// defaults reproduce the hand-crafted behaviour EXACTLY; a self-play optimiser
// (bench/tune-weights.mjs) perturbs them and the best vector can be loaded at
// startup via loadAiWeights(). Centralised here so tuning never edits the
// scoring logic itself. PIMC rollouts use this same heuristic, so improving
// these weights lifts every difficulty AND the search.
export const AI_WEIGHTS = {
  // ── follow (scoreFollow) ──
  fCost: 0.5,          // ×spendCost — conserve strong cards
  fAllyFeed: 2.5,      // ×points — pour points to a securely-winning partner
  fAllyKeep: 0.2,      // ×points — otherwise keep points low under a partner
  fAllySecure: 1.5,    // ×points — 3rd-hand-high: secure team points
  fAllySecureBase: 1,  // flat bonus for the secure play
  fEnemyWinPts: 2,     // ×points — reward for taking an enemy trick
  fEnemyWinBase: 1,    // flat bonus for contesting
  fRiskWin: 0.5,       // ×reward — discount when the win isn't secured
  fRiskOwnPts: 1.0,    // ×points — penalty: own points exposed to overtake
  fDuck: 0.4,          // ×reward — extra discount when a teammate can still take it
  fGiftPts: 3.5,       // ×points — penalty for gifting points to enemies
  // ── lead (scoreLead) ──
  lProbe: 0.5,         // base score of the safe low probe
  lProbeCard: 0.01,    // ×cardOrderValue tiebreak on the probe
  lNonBoss: 5,         // penalty for leading a beatable high card/combo
  lNonBossCard: 0.01,  // ×cardOrderValue tiebreak
  lBossBase: 3,        // base for cashing a boss combo
  lBossPts: 3,         // ×points banked
  lBossLen: 1.5,       // ×combo length (clear cards / pressure)
  lTrumpPull: 4,       // declarer pulling-trump bonus base
  lTrumpKeep: 2,       // penalty for leading trump when not pulling
  lAceRuff: 4          // penalty for cashing a bare side ace into ruff risk
};

// Merge an override object into AI_WEIGHTS in place (only known keys). Used by
// the tuner and by server startup to apply a saved weight vector.
export function loadAiWeights(overrides = {}) {
  for (const k of Object.keys(AI_WEIGHTS)) {
    if (typeof overrides[k] === "number" && Number.isFinite(overrides[k])) AI_WEIGHTS[k] = overrides[k];
  }
  return AI_WEIGHTS;
}

// Per-seat PRNG (advanced each draw) so same-level AIs don't play identically.
function aiRandom(seat) {
  let a = (seat.aiRngState ?? 0x9e3779b9) | 0;
  a = (a + 0x6D2B79F5) | 0;
  seat.aiRngState = a;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// Pick among scored candidates by softmax sampling. Low temperature ≈ argmax
// (hard, decisive); higher temperature spreads the choice over the *reasonable*
// options (easy, looser). Bad moves (point leaks, non-boss leads) score far lower,
// so their weight is ~0 — variety never becomes "瞎出". A small per-seat bias gives
// each AI a consistent personality.
function chooseWeighted(cands, scores, seat, profile) {
  if (cands.length <= 1) return cands[0] ?? null;
  let best = 0;
  for (let i = 1; i < scores.length; i += 1) if (scores[i] > scores[best]) best = i;
  const T = (profile.temp ?? 0.4) * (1 + 0.3 * (seat.aiBias ?? 0));
  if (T <= 0.02) return cands[best];
  const weights = scores.map((s) => Math.exp((s - scores[best]) / T));
  let total = 0;
  for (const w of weights) total += w;
  let r = aiRandom(seat) * total;
  for (let i = 0; i < cands.length; i += 1) { r -= weights[i]; if (r <= 0) return cands[i]; }
  return cands[best];
}

// Top-level entry: always returns a LEGAL play. The heuristic only *prefers*;
// every candidate is run through validatePlay, and any failure falls back to the
// conservative baseline. So the AI can never play an illegal/garbage move.
export function chooseAiPlay(room, seat, leaderCards = null) {
  const profile = aiProfile(seat);
  try {
    if (!leaderCards) {
      const lead = chooseLead(room, seat, profile);
      if (lead && lead.length && validatePlay(room, seat, lead, null).ok) return lead;
    } else {
      const follow = chooseFollow(room, seat, leaderCards, profile);
      // Validate the follow too (like the lead path): chooseFollow can, in rare
      // rule-consistency edge cases, return a play validatePlay rejects. Guarding
      // here guarantees chooseAiPlay never hands an illegal play to playCards —
      // otherwise the server would retry it forever and hang the table.
      if (follow && follow.length && validatePlay(room, seat, follow, leaderCards).ok) return follow;
    }
  } catch (_) { /* fall through to the safe baseline */ }
  return safeAiPlay(room, seat, leaderCards);
}

// Enumerate the de-duplicated LEGAL candidate plays for a seat — used by the
// search-based AI (PIMC/ISMCTS) to know which moves to evaluate. Mirrors what
// the heuristic considers: when leading, the develop-probe + every boss group;
// when following, the bounded legal-follow set. The heuristic's own pick is
// always appended so the list is never empty and never illegal.
export function legalCandidatePlays(room, seat, leaderCards = null) {
  const led = leaderCards || null;
  const out = [];
  const seen = new Set();
  const add = (cards) => {
    if (!cards || !cards.length) return;
    if (!validatePlay(room, seat, cards, led).ok) return;
    const key = cards.map((c) => c.id).slice().sort().join(",");
    if (seen.has(key)) return;
    seen.add(key);
    out.push(cards);
  };
  try {
    if (!led) for (const c of leadCandidates(room, seat)) add(c);
    else for (const c of followCandidates(room, seat, led)) add(c);
  } catch (_) { /* fall back to just the safe pick */ }
  add(chooseAiPlay(room, seat, led));
  return out;
}

// Conservative baseline (the original behaviour): follow with the lowest legal
// cards; lead the single lowest card. Guaranteed legal or a last-resort slice.
function safeAiPlay(room, seat, leaderCards) {
  if (!leaderCards) return [lowestCard(seat.hand, room)];
  const length = leaderCards.length;
  const attempts = [];
  attempts.push(...sameSuitCandidates(room, seat.hand, leaderCards, length));
  attempts.push(...simpleGroupedCandidates(seat.hand, length));
  attempts.push([...seat.hand].sort((a, b) => cardOrderValue(a, room) - cardOrderValue(b, room)).slice(0, length));
  for (const cards of attempts) {
    if (cards.length === length && validatePlay(room, seat, cards, leaderCards).ok) return cards;
  }
  const legal = findAnyLegalCombination(room, seat, leaderCards, length);
  if (legal) return legal;
  return legalFollow(room, seat, leaderCards);
}

// A guaranteed-legal follow, used when the bounded search above gives up (e.g.
// following a long tractor). If short of the led suit, play all of it plus the
// lowest fillers (the shape check is skipped when you can't fully follow). If you
// DO hold enough led-suit cards, a compliant play exists using only those — try
// the cheap shapes, then exhaustively search that small pool.
function legalFollow(room, seat, leaderCards) {
  const length = leaderCards.length;
  const ledSuit = playSuit(leaderCards[0], room);
  const ledAsc = seat.hand.filter((c) => playSuit(c, room) === ledSuit)
    .sort((a, b) => cardOrderValue(a, room) - cardOrderValue(b, room));
  if (ledAsc.length < length) {
    const fillers = seat.hand.filter((c) => playSuit(c, room) !== ledSuit)
      .sort((a, b) => cardOrderValue(a, room) - cardOrderValue(b, room));
    return [...ledAsc, ...fillers.slice(0, length - ledAsc.length)];
  }
  const ledDesc = [...ledAsc].reverse();
  const tryCands = [ledAsc.slice(0, length), ...simpleGroupedCandidates(ledAsc, length)];
  for (const t of findHandTractors(ledDesc, room)) if (t.length === length) tryCands.push(t);
  for (const c of tryCands) {
    if (c.length === length && validatePlay(room, seat, c, leaderCards).ok) return c;
  }
  const built = buildForcedFollow(room, seat, leaderCards);
  if (built) return built;
  const within = findAnyLegalCombination(room, seat, leaderCards, length, ledAsc);
  return within || ledAsc.slice(0, length);
}

// 结构化兜底：当 findAnyLegalCombination 因同门牌过多触发组合爆炸（超上限返回
// null）时，按 forcedRequirement 的要求确定性地拼出一手合法跟牌——先放满足强制
// 牌型（拖拉机 / 若干对子 / 对 / 三条）所需的最小牌，再用最小同门单张补足张数。
// shapeSatisfies 是“至少包含”语义，补单张只增不减组数，故构造结果能通过校验。
// 放在穷举之前调用，长拖拉机等情形直接 O(n log n) 解决，同时避开 8 万次慢穷举。
function buildForcedFollow(room, seat, leaderCards) {
  const length = leaderCards.length;
  const ledSuit = playSuit(leaderCards[0], room);
  const available = seat.hand.filter((c) => playSuit(c, room) === ledSuit);
  if (available.length < length) return null; // 短门由 legalFollow 上半段处理
  const lk = seat.lockedTriples || [];
  const lockedSet = new Set(lk);
  const isLocked = (g) => lockedSet.has(`${g[0].rank}|${g[0].suit}`);
  const wanted = forcedRequirement(analyzeShape(leaderCards, room), available, room, lk);
  const asc = [...available].sort((a, b) => cardOrderValue(a, room) - cardOrderValue(b, room));
  const desc = [...asc].reverse();

  const chosen = [];
  const used = new Set();
  const take = (cards) => { for (const c of cards) if (!used.has(c.id)) { used.add(c.id); chosen.push(c); } };

  if (wanted.type === "tractor") {
    const need = wanted.count * wanted.unit;
    const pool = wanted.unit === 2 ? available.filter((c) => !lockedSet.has(`${c.rank}|${c.suit}`)) : available;
    const found = wanted.unit === 3 ? findBestTractorRun(pool, room, 3) : findTractors(pool, room, need)[0];
    if (found) take(found.flatMap((g) => g.slice(0, wanted.unit)).slice(-need)); // 取最小的连续段
  } else if (wanted.type === "tripleFallback") {
    const groups = groupCards(desc);
    for (const g of groups.filter((gr) => gr.length >= 3).slice(-wanted.triples)) take(g.slice(0, 3));
    for (const g of groups.filter((gr) => gr.length >= 2 && !isLocked(gr) && !used.has(gr[0].id)).slice(-wanted.pairs)) take(g.slice(0, 2));
  } else if (wanted.type === "pairTractorFallback") {
    const run = findBestTractorRun(available.filter((c) => !lockedSet.has(`${c.rank}|${c.suit}`)), room, 2);
    if (run) take(run.slice(-wanted.tractorPairs).flatMap((g) => g.slice(0, 2)));
    const groups = groupCards(desc).filter((g) => g.length >= 2 && !isLocked(g) && !g.some((c) => used.has(c.id)));
    for (const g of groups.slice(-(wanted.pairs - wanted.tractorPairs))) take(g.slice(0, 2));
  } else if (wanted.type === "pairs") {
    const groups = groupCards(desc).filter((g) => g.length >= wanted.unit && !isLocked(g));
    for (const g of groups.slice(-wanted.count)) take(g.slice(0, wanted.unit)); // 最小的 count 组
  } else if (wanted.type === "triple") {
    const g = groupCards(desc).find((gr) => gr.length >= 3);
    if (g) take(g.slice(0, 3));
  } else if (wanted.type === "pair") {
    const g = groupCards(desc).find((gr) => gr.length >= 2 && !isLocked(gr));
    if (g) take(g.slice(0, 2));
  }
  for (const c of asc) { if (chosen.length >= length) break; take([c]); } // 最小同门单张补足
  if (chosen.length < length) return null;
  const out = chosen.slice(0, length);
  return validatePlay(room, seat, out, leaderCards).ok ? out : null;
}

// Relationship of `otherIndex` to `selfIndex` from self's knowledge.
// Only returns a confident "ally"/"enemy" when the friend is revealed; before
// that the dealer is a known enemy (to non-dealers) and everyone else is unknown.
function aiRelation(room, selfIndex, otherIndex) {
  if (otherIndex === selfIndex) return "self";
  // 固定队队伍从一开始就已知；找朋友（5人）则朋友亮明后才确定。
  if (isFixedTeamMode(room) || room.friendSeat !== null) {
    const team = dealerTeamSeats(room);
    return team.includes(selfIndex) === team.includes(otherIndex) ? "ally" : "enemy";
  }
  if (hasFriendMode(room) && room.friendCall && inferredFriendSeat(room, selfIndex) === selfIndex) {
    return otherIndex === room.dealerSeat ? "ally" : "enemy";
  }
  if (otherIndex === room.dealerSeat) return "enemy";
  return "unknown";
}

function inferredFriendSeat(room, seatIndex) {
  if (!hasFriendMode(room) || room.friendSeat !== null || seatIndex === room.dealerSeat) return null;
  const call = room.friendCall;
  if (!call || !call.rank || !call.suit) return null;
  const seat = room.seats[seatIndex];
  const inHand = seat.hand.filter((card) => card.rank === call.rank && card.suit === call.suit).length;
  if (inHand <= 0) return null;
  let dealerShown = 0;
  for (const t of room.finishedTricks) {
    for (const p of t.plays) {
      if (p.seat !== room.dealerSeat) continue;
      dealerShown += p.cards.filter((card) => card.rank === call.rank && card.suit === call.suit).length;
    }
  }
  for (const p of room.currentTrick) {
    if (p.seat !== room.dealerSeat) continue;
    dealerShown += p.cards.filter((card) => card.rank === call.rank && card.suit === call.suit).length;
  }
  return dealerShown >= call.ordinal - 1 && dealerShown + inHand >= call.ordinal ? seatIndex : null;
}

// Who currently holds the trick, and how it relates to me + points at stake.
function trickStanding(room, seat) {
  const trick = room.currentTrick;
  if (!trick.length) return null;
  const winnerSeat = determineTrickWinner(room, trick);
  const ledSuit = playSuit(trick[0].cards[0], room);
  const winPlay = trick.find((p) => p.seat === winnerSeat);
  // A ruff (trump played on a side-suit lead) is hard to overtake, so feeding the
  // partner points there is safe even when more players are still to act.
  const winnerRuffed = ledSuit !== "trump" && winPlay.cards.every((c) => playSuit(c, room) === "trump");
  return {
    winnerSeat,
    winnerCards: winPlay.cards,
    rel: aiRelation(room, seat.index, winnerSeat),
    points: trick.reduce((sum, play) => sum + play.points, 0),
    isLast: trick.length === room.seatCount - 1,
    winnerRuffed
  };
}

// Could an enemy (or as-yet-unknown player) still play after me this trick?
function enemyBehind(room, seat) {
  const remaining = room.seatCount - room.currentTrick.length - 1;
  let s = seat.index;
  for (let k = 0; k < remaining; k += 1) {
    s = nextSeat(s, room.seatCount);
    const r = aiRelation(room, seat.index, s);
    if (r === "enemy" || r === "unknown") return true;
  }
  return false;
}

// Would playing `cards` win the trick as it stands? Reuses the engine's own
// comparison so the AI's judgement always matches the actual ruling.
function candidateBeats(room, seat, cards) {
  if (!room.currentTrick.length) return true;
  const myPlay = { seat: seat.index, cards, shape: analyzeShapeWithLockedTriples(cards, room, seat.lockedTriples || []), points: 0 };
  return determineTrickWinner(room, [...room.currentTrick, myPlay]) === seat.index;
}

// Strategic "cost" of spending a card. Side cards ~ 2..14; trump compressed into
// a higher 15..30 band so the AI conserves trump but will still ruff for points.
function spendCost(card, room) {
  const v = cardOrderValue(card, room);
  return v >= 500 ? 15 + (v - 500) / 500 * 15 : v;
}

// Build a small, bounded set of legal follow candidates of the right length.
function followCandidates(room, seat, leaderCards) {
  const length = leaderCards.length;
  const ledSuit = playSuit(leaderCards[0], room);
  const raw = [];
  for (const c of sameSuitCandidates(room, seat.hand, leaderCards, length)) raw.push(c);
  for (const c of simpleGroupedCandidates(seat.hand, length)) raw.push(c);

  const sameDesc = seat.hand.filter((c) => playSuit(c, room) === ledSuit)
    .sort((a, b) => cardOrderValue(b, room) - cardOrderValue(a, room));
  if (sameDesc.length >= length) raw.push(sameDesc.slice(0, length));

  if (sameDesc.length === 0) {
    const trumps = seat.hand.filter((c) => playSuit(c, room) === "trump")
      .sort((a, b) => cardOrderValue(a, room) - cardOrderValue(b, room));
    if (trumps.length >= length) { raw.push(trumps.slice(0, length)); raw.push(trumps.slice(-length)); }
    raw.push([...seat.hand].sort((a, b) => cardOrderValue(a, room) - cardOrderValue(b, room)).slice(0, length));
  }
  const legal = findAnyLegalCombination(room, seat, leaderCards, length);
  if (legal) raw.push(legal);
  raw.push(legalFollow(room, seat, leaderCards)); // guaranteed-legal backstop

  const seen = new Set();
  const out = [];
  for (const c of raw) {
    if (c.length !== length) continue;
    if (!validatePlay(room, seat, c, leaderCards).ok) continue;
    const key = c.map((x) => x.id).slice().sort().join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function scoreFollow(room, seat, cards, stand, profile, seen) {
  const W = seat.aiWeights || AI_WEIGHTS; // per-seat override (tuning) else global
  const beats = candidateBeats(room, seat, cards);
  const cost = cards.reduce((sum, c) => sum + spendCost(c, room), 0);
  const pts = cards.reduce((sum, c) => sum + cardScore(c), 0);
  let u = -cost * W.fCost;

  // Partner holds the trick.
  if (stand.rel === "ally") {
    const allyBoss = stand.winnerRuffed || isComboBoss(room, seat, stand.winnerCards, seen);
    if (stand.isLast || allyBoss) {                 // securely winning → pour points in / keep low
      if (profile.feed) u += pts * W.fAllyFeed;
      else u -= pts * W.fAllyKeep;
      return u;
    }
    // 3rd-hand-high: ally winning but beatable and an enemy still acts behind me.
    // Secure the team's points — but ONLY with a guaranteed boss, never a card the
    // next player could beat, so I never waste a losable card on my own partner.
    if (beats && stand.points > 0 && enemyBehind(room, seat) && isComboBoss(room, seat, cards, seen)) {
      u += stand.points * W.fAllySecure + W.fAllySecureBase;
    } else {
      u -= pts * W.fAllyKeep;
    }
    return u;
  }

  // An enemy / unknown holds the trick.
  if (beats) {
    if (!profile.contest) { u -= 100; return u; } // easy never goes out of its way to win
    let reward = (stand.points * W.fEnemyWinPts + W.fEnemyWinBase) * (1 + 0.2 * (seat.aiBias ?? 0)); // +personality
    if (profile.riskAware && !stand.isLast) {       // win isn't secured if others still act
      reward *= W.fRiskWin;
      u -= pts * W.fRiskOwnPts;                      // and my own points could be overtaken
      if (allyBehind(room, seat)) reward *= W.fDuck; // a teammate can still take it — duck
    }
    u += reward;
  } else {
    u -= pts * W.fGiftPts;                           // never gift points to enemies/unknowns
    if (profile.voidDiscard) u += voidProgress(room, seat, cards); // shed toward a void
  }
  return u;
}

// Small nudge to discard from my shortest side suit, working toward a void I can
// later ruff. Tiny, so it only breaks ties among low non-point discards.
function voidProgress(room, seat, cards) {
  const counts = {};
  for (const c of seat.hand) if (playSuit(c, room) !== "trump") counts[c.suit] = (counts[c.suit] || 0) + 1;
  let b = 0;
  for (const c of cards) {
    if (playSuit(c, room) === "trump") continue;
    const n = counts[c.suit] || 1;
    if (n <= 3) b += (4 - n) * 0.6; // shorter suit → bigger nudge to empty it
  }
  return b;
}

// Is a known teammate still due to play after me in the current trick?
function allyBehind(room, seat) {
  const remaining = room.seatCount - room.currentTrick.length - 1;
  let s = seat.index;
  for (let k = 0; k < remaining; k += 1) {
    s = nextSeat(s, room.seatCount);
    if (aiRelation(room, seat.index, s) === "ally") return true;
  }
  return false;
}

function chooseFollow(room, seat, leaderCards, profile) {
  const stand = trickStanding(room, seat);
  const seen = seenCounts(room, seat);
  const allySecure = stand?.rel === "ally" && (stand.isLast || stand.winnerRuffed || isComboBoss(room, seat, stand.winnerCards, seen));
  const preferredSingle = allySecure ? null : preferredSingleFollow(room, seat, leaderCards);
  if (preferredSingle && validatePlay(room, seat, preferredSingle, leaderCards).ok) return preferredSingle;
  const cands = followCandidates(room, seat, leaderCards);
  if (!cands.length) return null;
  const scores = cands.map((c) => scoreFollow(room, seat, c, stand, profile, seen));
  return chooseWeighted(cands, scores, seat, profile);
}

function preferredSingleFollow(room, seat, leaderCards) {
  if (!leaderCards || leaderCards.length !== 1) return null;
  const ledSuit = playSuit(leaderCards[0], room);
  const available = seat.hand
    .filter((card) => playSuit(card, room) === ledSuit)
    .sort((a, b) => cardOrderValue(a, room) - cardOrderValue(b, room));
  if (available.length === 0) return null; // 缺门垫牌仍交给 AI 做空门/保大牌逻辑

  const groups = groupCards(available);
  const singletonCards = groups.filter((g) => g.length === 1).map((g) => g[0]);
  const nonPointSingleton = singletonCards.find((card) => cardScore(card) === 0);
  if (nonPointSingleton) return [nonPointSingleton];

  // 如果自然单张全是分牌，才考虑拆对子/三条里的非分牌，保住分牌和更大的单张。
  if (singletonCards.length > 0) {
    const splitNonPoint = groups
      .filter((g) => g.length >= 2)
      .map((g) => g[0])
      .find((card) => cardScore(card) === 0);
    if (splitNonPoint) return [splitNonPoint];
    return [singletonCards[0]];
  }

  return null;
}

// Leading. easy dumps the lowest card. medium/hard build candidate leads — the
// safe low probe plus every *boss* group they hold (pairs/tractors/trump/point
// winners the opponents can no longer out-group) — and lead the best-scoring one.
// Because only boss combos are offered alongside the probe, a multi-card or high
// lead is always a winner (it can't be out-grouped); side combos accept the small
// ruff risk a human also accepts when cashing winners.
function chooseLead(room, seat, profile) {
  const hand = seat.hand;
  const friendLead = dealerFriendSignalLead(room, seat, profile);
  if (friendLead && validatePlay(room, seat, friendLead, null).ok) return friendLead;
  const seen = seenCounts(room, seat);
  const cands = leadCandidates(room, seat).filter((c) => validatePlay(room, seat, c, null).ok);
  if (!cands.length) return [lowestCard(hand, room)];
  const scores = cands.map((c) => scoreLead(room, seat, c, profile, seen));
  return chooseWeighted(cands, scores, seat, profile);
}

function leadCandidates(room, seat) {
  const sortedDesc = [...seat.hand].sort((a, b) => cardOrderValue(b, room) - cardOrderValue(a, room));
  const groups = groupCards(sortedDesc);
  const cands = [developProbe(room, seat, groups)];
  for (const g of groups) {
    if (g.length >= 3) cands.push(g.slice(0, 3)); // triple
    if (g.length >= 2) cands.push(g.slice(0, 2)); // pair
    cands.push([g[0]]);                            // single (boss winners are cashed)
  }
  for (const t of findHandTractors(sortedDesc, room)) {
    // Skip TRUMP tractors: the engine's two tractor checks (forcedRequirement's
    // findTractors vs analyzeShape's isConsecutiveInRules) disagree on joker/level
    // trump runs, which can leave a follower with no legal play. Side-suit tractors
    // are safe (both checks agree there). Trump is still pulled via pairs/singles.
    if (t.every((c) => playSuit(c, room) === "trump")) continue;
    cands.push(t);
  }
  return cands;
}

// The safe default: lowest non-point singleton from the longest side suit.
function developProbe(room, seat, groups) {
  const singletonIds = new Set(groups.filter((g) => g.length === 1).map((g) => g[0].id));
  const bySuit = {};
  for (const c of seat.hand) {
    if (playSuit(c, room) === "trump") continue;
    (bySuit[c.suit] ||= []).push(c);
  }
  const suits = Object.keys(bySuit).sort((a, b) => bySuit[b].length - bySuit[a].length);
  for (const s of suits) {
    const pick = bySuit[s]
      .filter((c) => cardScore(c) === 0 && singletonIds.has(c.id))
      .sort((a, b) => cardOrderValue(a, room) - cardOrderValue(b, room))[0];
    if (pick) return [pick];
  }
  const anyLow = Object.values(bySuit).flat()
    .filter((c) => cardScore(c) === 0)
    .sort((a, b) => cardOrderValue(a, room) - cardOrderValue(b, room))[0];
  return anyLow ? [anyLow] : [lowestCard(seat.hand, room)];
}

function scoreLead(room, seat, cards, profile, seen) {
  const W = seat.aiWeights || AI_WEIGHTS; // per-seat override (tuning) else global
  const head = [...cards].sort((a, b) => cardOrderValue(b, room) - cardOrderValue(a, room))[0];
  const isTrump = playSuit(head, room) === "trump";
  const pts = cards.reduce((s, c) => s + cardScore(c), 0);
  const len = cards.length;
  const boss = isComboBoss(room, seat, cards, seen);

  // Non-point low single = the probe: pick it only when nothing is worth cashing.
  if (len === 1 && !boss && cardScore(head) === 0) return W.lProbe - cardOrderValue(head, room) * W.lProbeCard;
  // A non-boss high card / combo can be beaten or ruffed. Master still prefers
  // meaningful side-suit structures over a pointless low single: pairs/triples/
  // tractors often take control even when not mathematically boss yet.
  if (!boss) {
    if (profile.masterLead && !isTrump && len >= 2) {
      const ruffable = enemyVoidIn(room, seat, head.suit) || suitPlayed(room, head.suit) > 8;
      return 1.2 + len * 1.1 + cardOrderValue(head, room) * 0.08 + pts * 0.35 - (ruffable ? 2.5 : 0);
    }
    return -W.lNonBoss - cardOrderValue(head, room) * W.lNonBossCard - len;
  }

  // Boss combo: cash a guaranteed winner — bank points, clear cards, apply pressure.
  let u = W.lBossBase + pts * W.lBossPts + len * W.lBossLen;
  if (isTrump) {
    // Declarer pulls trump from strength (basic). easy doesn't manage trump, so it
    // doesn't get the pull bonus and leaves its trump back.
    if (seat.index === room.dealerSeat && profile.pull) u += W.lTrumpPull + len;
    else u -= W.lTrumpKeep;
  } else if (len === 1 && pts === 0) {
    // Cashing a bare side ace is basic, but it risks a ruff once the suit dries up
    // or an opponent is known void — back off then (all levels read this much).
    const ruffable = enemyVoidIn(room, seat, head.suit) || suitPlayed(room, head.suit) > 8;
    if (ruffable) u -= W.lAceRuff;
  }
  return u;
}

function dealerFriendSignalLead(room, seat, profile) {
  if (!profile.masterLead || seat.index !== room.dealerSeat || room.friendSeat !== null) return null;
  const call = room.friendCall;
  if (!call || call.suit === "joker") return null;
  const own = seat.hand
    .filter((card) => card.rank === call.rank && card.suit === call.suit)
    .sort((a, b) => cardOrderValue(b, room) - cardOrderValue(a, room));
  if (!own.length) return null;
  return [own[0]];
}

// Has `seatIndex` shown void in `suit` (a side suit) — i.e. failed to follow it
// in a past trick? Used by hard to judge ruff risk when cashing winners.
function isVoidIn(room, seatIndex, suit) {
  for (const t of room.finishedTricks) {
    if (playSuit(t.plays[0].cards[0], room) !== suit) continue;
    const play = t.plays.find((p) => p.seat === seatIndex);
    if (play && !play.cards.some((c) => playSuit(c, room) === suit)) return true;
  }
  return false;
}

function enemyVoidIn(room, seat, suit) {
  for (const other of room.seats) {
    if (other.index === seat.index) continue;
    if (aiRelation(room, seat.index, other.index) === "ally") continue;
    if (isVoidIn(room, other.index, suit)) return true;
  }
  return false;
}

// ── card-counting helpers for "boss" detection ──────────────
// A group (single/pair/triple/tractor) is "boss" when no opponent can still
// assemble a higher group of the same width: for every stronger card type the
// copies not yet seen (3 − seen) are fewer than the group's width.
function cardKey(c) { return (c.rank === "bigJoker" || c.rank === "smallJoker") ? c.rank : `${c.rank}|${c.suit}`; }

function seenCounts(room, seat) {
  const m = new Map();
  const bump = (c) => m.set(cardKey(c), (m.get(cardKey(c)) || 0) + 1);
  for (const c of seat.hand) bump(c);
  for (const t of room.finishedTricks) for (const p of t.plays) for (const c of p.cards) bump(c);
  for (const p of room.currentTrick) for (const c of p.cards) bump(c);
  return m;
}

function suitPlayed(room, suit) {
  let n = 0;
  for (const t of room.finishedTricks) for (const p of t.plays) for (const c of p.cards) if (c.suit === suit) n += 1;
  return n;
}

// Card types that out-rank `head` and could beat its group if grouped together.
function strongerTypes(room, head) {
  const headVal = cardOrderValue(head, room);
  const out = [];
  if (playSuit(head, room) === "trump") {
    if (headVal < 1000) out.push("bigJoker");
    if (headVal < 990) out.push("smallJoker");
    for (const s of SUITS) if (cardOrderValue({ rank: room.levelRank, suit: s }, room) > headVal) out.push(`${room.levelRank}|${s}`);
    if (!room.noTrump && room.trumpSuit) {
      for (const r of RANKS) {
        if (r === room.levelRank) continue;
        if (cardOrderValue({ rank: r, suit: room.trumpSuit }, room) > headVal) out.push(`${r}|${room.trumpSuit}`);
      }
    }
  } else {
    for (const r of RANKS) { // only higher cards of the SAME side suit out-group it
      if (r === room.levelRank || r === head.rank) continue;
      const c = { rank: r, suit: head.suit };
      if (playSuit(c, room) !== "trump" && cardOrderValue(c, room) > headVal) out.push(`${r}|${head.suit}`);
    }
  }
  return out;
}

function isGroupBoss(room, head, unit, seen) {
  for (const k of strongerTypes(room, head)) {
    if (3 - (seen.get(k) || 0) >= unit) return false; // an opponent could still out-group it
  }
  return true;
}

function isComboBoss(room, seat, cards, seen) {
  const shape = analyzeShape(cards, room);
  if (shape.type === "throw" || shape.type === "empty") return false;
  const groups = groupCards([...cards].sort((a, b) => cardOrderValue(b, room) - cardOrderValue(a, room)));
  const unit = shape.type === "tractor" ? shape.unit : groups[0].length;
  return isGroupBoss(room, groups[0][0], unit, seen);
}

// Find tractors held in `sortedDesc` (consecutive pairs/triples by the engine's
// own ordering), e.g. ♣10♣10♣J♣J → one 4-card tractor.
function findHandTractors(sortedDesc, room) {
  const pairGroups = groupCards(sortedDesc).filter((g) => g.length >= 2);
  const out = [];
  let i = 0;
  while (i < pairGroups.length) {
    let j = i;
    while (j + 1 < pairGroups.length) {
      const a = pairGroups[j][0];
      const b = pairGroups[j + 1][0];
      const suit = playSuit(a, room);
      if (playSuit(b, room) === suit && isConsecutiveInRules(a, b, suit, room)) j += 1;
      else break;
    }
    if (j > i) {
      const run = pairGroups.slice(i, j + 1);
      const unit = Math.min(...run.map((g) => g.length));
      out.push(run.flatMap((g) => g.slice(0, unit)));
    }
    i = j + 1;
  }
  return out;
}

// Derive team scores from each seat's captured trick points plus failed-throw
// penalties, using the CURRENT team assignment. This implements rule 96: points
// follow the individual until teams are known, so when the friend is revealed,
// the points they captured before reveal move to the dealer team automatically.
export function recomputeScores(room) {
  let attackers = 0;
  let dealerTeam = 0;
  let attackerThrowPenalty = 0;
  let dealerThrowPenalty = 0;
  let netThrowToAttackers = 0;
  for (const seat of room.seats) {
    if (isDealerTeam(room, seat.index)) dealerTeam += seat.takenTrickPoints;
    else attackers += seat.takenTrickPoints;
  }
  // Failed-throw penalties: the thrower's team loses 10. Expressed as an attacker
  // delta (dealer-team penalty benefits the attackers, attacker penalty reduces them).
  for (const [idxStr, penalty] of Object.entries(room.seatPersonalScores || {})) {
    if (penalty >= 0) continue;
    const idx = Number(idxStr);
    if (isDealerTeam(room, idx)) {
      dealerThrowPenalty += Math.abs(penalty);
      netThrowToAttackers += Math.abs(penalty);
      attackers += Math.abs(penalty);
    } else {
      attackerThrowPenalty += Math.abs(penalty);
      netThrowToAttackers += penalty;
      attackers += penalty;
    }
  }
  room.scores = { attackers: Math.max(0, attackers), dealerTeam };
  room.throwPenaltyStats = {
    attackers: attackerThrowPenalty,
    dealerTeam: dealerThrowPenalty,
    netToAttackers: netThrowToAttackers
  };
}

function finishTrick(room) {
  const winner = determineTrickWinner(room, room.currentTrick);
  const points = room.currentTrick.reduce((sum, play) => sum + play.points, 0);
  room.seats[winner].takenTrickPoints += points;
  recomputeScores(room);
  room.finishedTricks.push({ plays: room.currentTrick, winner, points });
  room.tableLog.push(`${seatName(room, winner)} 赢得本墩，${points} 分。`);
  // 供前端播放“本墩得分飞向赢家”的动画：seq 单调递增（每局从 1 开始）用于检测新墩。
  room.lastTrickWin = { winner, points, seq: room.finishedTricks.length };
  room.lastTrick = room.currentTrick;
  room.currentTrick = [];
  room.autoFinishLastTrick = false;
  if (room.seats.every((seat) => seat.hand.length === 0)) {
    finishRound(room, winner);
    return;
  }
  room.currentLeader = winner;
  room.turnSeat = winner;
  room.trickPauseUntil = Date.now() + 600;
}

// 通关判定：升级是 A→2 循环、没有封顶，故“当前已是 A 还要再升（steps≥1）”即视为
// 越过 A 夺冠。不额外强加“打 A 必须守庄”那道坎（简化规则，可按需收紧）。
export function crossesChampion(level, steps) {
  return steps > 0 && level === "A";
}

function finishRound(room, lastWinner) {
  // Final settlement: recompute team scores from each seat's captured points
  // using the final team assignment (rule 96), then add the doubled kitty bonus.
  recomputeScores(room);

  const kittyPoints = room.hiddenKitty.reduce((sum, card) => sum + cardScore(card), 0);
  let buriedBonus = 0;
  if (!isDealerTeam(room, lastWinner)) {
    buriedBonus = kittyPoints * buryMultiplier(room, room.finishedTricks.at(-1)?.plays.find((play) => play.seat === lastWinner));
    room.scores.attackers += buriedBonus;
  }
  const attackers = room.scores.attackers;
  const result = isClassic4(room) ? upgradeResultClassic4(attackers)
    : isFixedTeamMode(room) ? upgradeResultSix(attackers)
      : upgradeResult(attackers);
  const upgradedSeats = result.steps > 0
    ? (result.side === "dealer" ? dealerTeamSeats(room) : attackerSeats(room))
    : [];
  // 通关：升级方若已在 A 上还要再升（越过 A），即夺冠。
  let champion = null;
  if (isFixedTeamMode(room)) {
    // 固定队轮庄：升级赢队的共享等级；并决定下局坐庄（庄家队守住→连庄、轮到隔座队友；
    // 闲家队上台→下家坐庄、坐庄队易主）。
    if (result.steps > 0) {
      const winParity = result.side === "dealer" ? room.dealerSeat % 2 : (room.dealerSeat + 1) % 2;
      if (crossesChampion(room.teamLevels[winParity], result.steps)) champion = result.side;
      room.teamLevels[winParity] = levelAdvance(room.teamLevels[winParity], result.steps);
    }
    for (const seat of room.seats) seat.level = room.teamLevels[seat.index % 2]; // 同步每人显示=队等级
    const dealerHeld = result.side === "dealer";
    room.nextDealerSeat = dealerHeld
      ? (room.dealerSeat + 2) % room.seatCount  // 连庄：轮到隔座同队下一人
      : (room.dealerSeat + 1) % room.seatCount; // 闲家上台：下家（异队）坐庄
  } else {
    for (const seatIndex of upgradedSeats) {
      const seat = room.seats[seatIndex];
      if (crossesChampion(seat.level, result.steps)) champion = result.side;
      seat.level = levelAdvance(seat.level, result.steps);
    }
  }
  room.lastResult = { attackers, buriedBonus, result, upgradedSeats, champion, hiddenKitty: room.hiddenKitty };
  // 战绩：累积每局结果，供“战绩”面板展示。
  (room.matchLog ||= []).push({
    round: room.round, attackers, label: result.label,
    dealerSeat: room.dealerSeat, friendSeat: room.friendSeat,
    champion, levels: room.seats.map((s) => s.level)
  });
  room.phase = PHASES.ROUND_OVER;
  for (const seat of room.seats) {
    if (!seat.isAi) seat.trustee = false;
  }
  const champLabel = champion === "dealer" ? "（庄家队打过 A，夺冠！🏆）"
    : champion === "attackers" ? "（闲家队打过 A，夺冠！🏆）" : "";
  room.tableLog.push(`本局结束，闲家 ${attackers} 分。${result.label}${champLabel}`);
}

export function resetToLobby(room) {
  assertPhase(room, PHASES.ROUND_OVER);
  room.phase = PHASES.LOBBY;
  for (const seat of room.seats) {
    seat.hand = [];
    seat.takenTrickPoints = 0;
  }
}

export function evaluateBid(cards, playerLevel) {
  return findFriend5Mode.evaluateFindFriend5Bid(cards, playerLevel);
}

export function compareBid(a, b) {
  return a.strength - b.strength;
}

// 核心修复：精准分析手牌结构，严格划分拖拉机、对子与甩牌
export function analyzeShape(cards, room) {
  return modeRules(room).analyzeShape(cards, room);
}

function analyzeShapeWithLockedTriples(cards, room, lockedTriples = []) {
  return modeRules(room).analyzeShapeWithLockedTriples(cards, room, lockedTriples);
}

function analyzeShapeFromGroups(cards, room, groups) {
  return modeRules(room).analyzeShapeFromGroups(cards, room, groups);
}

function isTrueTractor(groups, room) {
  return modeRules(room).isTrueTractor(groups, room);
}

function isConsecutiveInRules(cardA, cardB, ledSuit, room) {
  return modeRules(room).isConsecutiveInRules(cardA, cardB, ledSuit, room);
}

function getNextImmediateTrumpValue(currentValue, room) {
  return modeRules(room).getNextImmediateTrumpValue(currentValue, room);
}

export function validatePlay(room, seat, cards, leaderCards) {
  return modeRules(room).validatePlay(room, seat, cards, leaderCards);
}

function validateThrowFollow(room, seat, cards, leaderCards, ledSuit, available, leaderLockedTriples = []) {
  return modeRules(room).validateThrowFollow(room, seat, cards, leaderCards, ledSuit, available, leaderLockedTriples);
}

function decomposeThrowComponents(cards, room, ledSuit, lockedTriples = []) {
  return modeRules(room).decomposeThrowComponents(cards, room, ledSuit, lockedTriples);
}

function opponentHasBetterTractor(otherSameSuit, room, unit, count, headValue, ledSuit, lockedTriples = []) {
  return modeRules(room).opponentHasBetterTractor(otherSameSuit, room, unit, count, headValue, ledSuit, lockedTriples);
}

function validateThrow(room, throwerSeat, cards) {
  return modeRules(room).validateThrow(room, throwerSeat, cards);
}

function findThrowKeepCards(cards, blockedGroup, room) {
  return modeRules(room).findThrowKeepCards(cards, blockedGroup, room);
}

function isStructureMatch(cardsA, cardsB) {
  return findFriend5Mode.isStructureMatch(cardsA, cardsB);
}

export function determineTrickWinner(room, plays) {
  return modeRules(room).determineTrickWinner(room, plays);
}

export function upgradeResult(attackers) {
  return findFriend5Mode.upgradeResultFindFriend5(attackers);
}

export function upgradeResultSix(attackers) {
  return fixedTeam6Mode.upgradeResultFixedTeam6(attackers);
}

export const upgradeResultClassic4 = classic4Mode.upgradeResultClassic4;

function comparePlay(room, challenger, currentBest, leadPlay) {
  return modeRules(room).comparePlay(room, challenger, currentBest, leadPlay);
}

function lockedTriplesForPlay(room, play) {
  return modeRules(room).lockedTriplesForPlay(room, play);
}

function compareByHighestTier(challengerCards, bestCards, room, leaderCards, options = {}) {
  return modeRules(room).compareByHighestTier(challengerCards, bestCards, room, leaderCards, options);
}

function highestThrowTier(cards, room, lockedTriples = []) {
  return modeRules(room).highestThrowTier(cards, room, lockedTriples);
}

function matchingThrowTierValue(cards, room, target, lockedTriples = [], options = {}) {
  return modeRules(room).matchingThrowTierValue(cards, room, target, lockedTriples, options);
}

function isAllTrumpCards(cards, room) {
  return modeRules(room).isAllTrumpCards(cards, room);
}

function throwStructureMatch(trumpCards, leaderCards, room, trumpLockedTriples = [], leaderLockedTriples = []) {
  return modeRules(room).throwStructureMatch(trumpCards, leaderCards, room, trumpLockedTriples, leaderLockedTriples);
}

function getShapeComparativeValue(cards, room) {
  return modeRules(room).getShapeComparativeValue(cards, room);
}

export function cardOrderValue(card, room) {
  return modeRules(room).cardOrderValue(card, room);
}

export function playSuit(card, room) {
  return modeRules(room).playSuit(card, room);
}

function lockedPairViolation(seat, cards, room) {
  return modeRules(room).lockedPairViolation(seat, cards, room);
}

function requirementSatisfiedWithoutLockedPair(cards, wanted, room, lockedKey) {
  return modeRules(room).requirementSatisfiedWithoutLockedPair(cards, wanted, room, lockedKey);
}

function recordTripleLockDecision(room, seat, cards, leaderCards) {
  return modeRules(room).recordTripleLockDecision(room, seat, cards, leaderCards);
}

function pairDemandForTripleChoice(leaderShape, leaderCards, room) {
  return modeRules(room).pairDemandForTripleChoice(leaderShape, leaderCards, room);
}

function forcedRequirement(leaderShape, available, room, lockedTriples = []) {
  return modeRules(room).forcedRequirement(leaderShape, available, room, lockedTriples);
}

function naturalPairPool(cards, room, lockedSet = new Set()) {
  return modeRules(room).naturalPairPool(cards, room, lockedSet);
}

function shapeSatisfies(actual, wanted, cards, available, room, lockedTriples = []) {
  return modeRules(room).shapeSatisfies(actual, wanted, cards, available, room, lockedTriples);
}

function groupCards(sortedCards) {
  return findFriend5Mode.groupCards(sortedCards);
}

function groupCardsRespectingLockedTriples(sortedCards, lockedTriples = []) {
  return findFriend5Mode.groupCardsRespectingLockedTriples(sortedCards, lockedTriples);
}

function tractorUnitSize(groups) {
  return findFriend5Mode.tractorUnitSize(groups);
}

function isConsecutiveGroups(groups, room) {
  return modeRules(room).isConsecutiveGroups(groups, room);
}

function findTractors(cards, room, length) {
  return modeRules(room).findTractors(cards, room, length);
}

function findBestTractorRun(cards, room, unit = 2) {
  return modeRules(room).findBestTractorRun(cards, room, unit);
}

function hasGroup(cards, size) {
  return findFriend5Mode.hasGroup(cards, size);
}

function isAiSeat(room, seatIndex) {
  return room.seats[seatIndex]?.isAi === true;
}

// A seat acts automatically if it's an AI bot OR a human who turned on 托管.
function isAutoSeat(room, seatIndex) {
  const s = room.seats[seatIndex];
  return !!s && (s.isAi === true || s.trustee === true);
}

export function chooseAiBury(room, dealer) {
  const profile = aiProfile(dealer);
  const hand = dealer.hand;
  // easy: keep points but otherwise just bury the lowest cards (no void planning).
  if (!profile.voidDiscard) {
    return [...hand]
      .sort((a, b) => cardScore(a) - cardScore(b) || cardOrderValue(a, room) - cardOrderValue(b, room))
      .slice(0, room.kittySize);
  }
  // medium/hard: keep points, trump and side Aces; bury junk while emptying the
  // shortest side suits first so the dealer can later ruff (扣底造空门).
  const isTrump = (c) => playSuit(c, room) === "trump";
  const suitLen = {};
  for (const c of hand) if (!isTrump(c)) suitLen[c.suit] = (suitLen[c.suit] || 0) + 1;
  const junk = hand
    .filter((c) => !isTrump(c) && cardScore(c) === 0 && c.rank !== "A")
    .sort((a, b) => (suitLen[a.suit] - suitLen[b.suit]) || (cardOrderValue(a, room) - cardOrderValue(b, room)));
  const bury = junk.slice(0, room.kittySize);
  if (bury.length < room.kittySize) {
    // Not enough junk: add the least valuable remainder, keeping points/trump for last.
    const used = new Set(bury.map((c) => c.id));
    const rank = (c) => (cardScore(c) > 0 ? 2 : 0) + (isTrump(c) ? 1 : 0);
    const extra = hand
      .filter((c) => !used.has(c.id))
      .sort((a, b) => rank(a) - rank(b) || cardOrderValue(a, room) - cardOrderValue(b, room));
    for (const c of extra) { if (bury.length >= room.kittySize) break; bury.push(c); }
  }
  return bury.slice(0, room.kittySize);
}

// Call a high SIDE card the dealer can't fully satisfy alone (ordinal = how many
// copies the dealer already holds + 1), so a real partner is recruited instead
// of the dealer accidentally becoming its own friend (which forced 4打1).
export function chooseAiFriendCard(room, dealer) {
  const level = room.levelRank;
  const isTrump = (c) => playSuit(c, room) === "trump";
  const suitLen = {};
  for (const c of dealer.hand) if (!isTrump(c)) suitLen[c.suit] = (suitLen[c.suit] || 0) + 1;
  const primary = level === "A" ? "K" : "A";
  const RANK_PREF = [primary, "A", "K", "10", "Q", "J", "9", "8", "7", "6", "5"]
    .filter((rank, index, arr) => rank !== level && arr.indexOf(rank) === index);
  let best = null;
  for (const rank of RANK_PREF) {
    for (const suit of SUITS) {
      const held = dealer.hand.filter((c) => c.rank === rank && c.suit === suit).length;
      const ordinal = held + 1;
      if (ordinal > 3) continue; // dealer holds all 3 copies — nobody else can have it
      const pts = (rank === "K" || rank === "10" || rank === "5") ? 1 : 0;
      const isPrimary = rank === primary;
      const transfer = isPrimary ? (held > 0 ? 95 : 80) : 0;
      const score = transfer + rankNumber(rank) + pts * 5 - (suitLen[suit] || 0) * 3 - Math.max(0, held - 1) * 8;
      if (!best || score > best.score) best = { ordinal, rank, suit, score };
    }
  }
  if (best) return { ordinal: best.ordinal, rank: best.rank, suit: best.suit };
  const c = dealer.hand.find((card) => card.rank !== "bigJoker" && card.rank !== "smallJoker") ?? dealer.hand[0];
  return { ordinal: 1, rank: c.rank, suit: c.suit };
}

// Forced dealer: medium/hard reveal their strongest own trump suit if clearly
// better than the kitty-card suit (must hold a level card of it); easy keeps it.
function chooseAiForcedTrump(room, dealer) {
  const profile = aiProfile(dealer);
  const level = room.levelRank ?? dealer.level;
  const suitStrength = (s) => dealer.hand.filter((c) => c.suit === s || c.rank === level || c.suit === "joker").length;
  // 固定队轮庄：庄家必须定主，从所有花色里选最强的（不要求手里有级牌）。
  if (isFixedTeamMode(room)) {
    let best = null;
    for (const s of SUITS) {
      const strength = suitStrength(s);
      if (!best || strength > best.strength) best = { suit: s, strength };
    }
    return best ? best.suit : SUITS[0];
  }
  if (!profile.pull) return null; // easy doesn't manage trump — keep the kitty suit
  // Use the round's level rank (what chooseForcedTrump validates against) so we
  // never propose a suit the dealer can't actually reveal a level card for.
  let best = null;
  for (const s of SUITS) {
    if (!dealer.hand.some((c) => c.rank === level && c.suit === s)) continue;
    const strength = suitStrength(s);
    if (!best || strength > best.strength) best = { suit: s, strength };
  }
  if (!best) return null;
  const curStrength = room.trumpSuit ? suitStrength(room.trumpSuit) : 0;
  return best.strength > curStrength + 1 ? best.suit : null;
}

// Auction decision (driven by the server's bid scheduler, never by runAiStep, so
// it doesn't bypass the reveal/timeout pacing). Returns { cardIds, strength } to
// bid, or null to not bid. Only ever returns cards the seat actually holds.
export function decideAiBid(room, seat) {
  const profile = aiProfile(seat);
  if (profile.autoBid === false) return null;
  const hand = seat.hand;
  const level = seat.level;
  const jokers = hand.filter((c) => c.suit === "joker").length;
  // Candidate bid suits = suits where I hold a level card. Pick the one that makes
  // the strongest trump (most jokers + level cards + that suit), not just the suit
  // with the most level cards.
  const levelBySuit = {};
  for (const c of hand) if (c.rank === level && c.suit !== "joker") (levelBySuit[c.suit] ||= []).push(c);
  let best = null;
  for (const s of Object.keys(levelBySuit)) {
    const strength = Math.min(levelBySuit[s].length, 3);
    const trumpCount = hand.filter((c) => c.suit === "joker" || c.rank === level || c.suit === s).length;
    if (!best || trumpCount > best.trumpCount) best = { suit: s, strength, trumpCount, cards: levelBySuit[s].slice(0, strength) };
  }
  if (!best) return null; // no level card → nothing legal to bid with

  // Worth being dealer if trump-rich, or if I hold strong top control (≥2 jokers).
  const ratio = best.trumpCount / hand.length;
  const worthy = ratio >= profile.bidRatio || (jokers >= 2 && best.trumpCount >= hand.length * 0.4);
  if (!worthy) return null;
  if (room.currentBid && best.strength <= room.currentBid.strength) return null; // can't beat
  return { cardIds: best.cards.map((c) => c.id), strength: best.strength };
}

export function decideAiSixTrump(room, seat) {
  const profile = aiProfile(seat);
  if (profile.autoBid === false) return null;
  const hand = seat.hand;
  const level = room.dealerSeat === null ? seat.level : room.levelRank;
  const jokerCards = hand.filter((c) => c.suit === "joker").slice(0, 3);
  if (jokerCards.length === 3) {
    const jokerBid = fixedTeam6Mode.evaluateFixedTeam6TrumpCall(jokerCards, level);
    if (jokerBid && (!room.currentBid || compareBid(jokerBid, room.currentBid) > 0)) {
      return { cardIds: jokerCards.map((c) => c.id), strength: jokerBid.strength };
    }
  }
  const levelBySuit = {};
  for (const c of hand) if (c.rank === level && c.suit !== "joker") (levelBySuit[c.suit] ||= []).push(c);
  let best = null;
  for (const s of Object.keys(levelBySuit)) {
    const strength = Math.min(levelBySuit[s].length, 3);
    const trumpCount = hand.filter((c) => c.suit === "joker" || c.rank === level || c.suit === s).length;
    if (!best || strength > best.strength || (strength === best.strength && trumpCount > best.trumpCount)) {
      best = { suit: s, strength, trumpCount, cards: levelBySuit[s].slice(0, strength) };
    }
  }
  if (!best) return null;
  const ratio = best.trumpCount / Math.max(1, hand.length);
  const eagerFirstDealer = room.dealerSeat === null && best.strength >= 1;
  // 守庄队在后续局应主动定主：定主只定花色、不改坐庄，不亮反而可能被对家反主成不利
  // 花色、或全员不亮触发换台/重发。所以只要手里有一张级牌就亮自己最强的花色。
  const onDealerTeam = room.dealerSeat !== null && isFixedTeamMode(room) && seat.index % 2 === room.dealerSeat % 2;
  const eagerHold = onDealerTeam && best.strength >= 1;
  const worthy = eagerFirstDealer || eagerHold || best.strength >= 2 || ratio >= profile.bidRatio;
  if (!worthy) return null;
  if (room.currentBid && best.strength <= room.currentBid.strength) return null;
  return { cardIds: best.cards.map((c) => c.id), strength: best.strength };
}

function lowestCard(hand, room) {
  return [...hand].sort((a, b) => cardOrderValue(a, room) - cardOrderValue(b, room) || cardScore(a) - cardScore(b))[0];
}

function sameSuitCandidates(room, hand, leaderCards, length) {
  const ledSuit = playSuit(leaderCards[0], room);
  const sameSuit = hand.filter((card) => playSuit(card, room) === ledSuit)
    .sort((a, b) => cardOrderValue(a, room) - cardOrderValue(b, room));
  const out = [];
  if (sameSuit.length >= length) out.push(sameSuit.slice(0, length));
  if (sameSuit.length > 0 && sameSuit.length < length) {
    const fillers = hand.filter((card) => !sameSuit.includes(card))
      .sort((a, b) => cardOrderValue(a, room) - cardOrderValue(b, room));
    out.push([...sameSuit, ...fillers.slice(0, length - sameSuit.length)]);
  }
  return out;
}

function simpleGroupedCandidates(hand, length) {
  const groups = groupCards(hand);
  const out = [];
  for (const group of groups) {
    if (group.length >= length) out.push(group.slice(0, length));
  }
  if (length % 2 === 0) {
    const pairs = groups.filter((group) => group.length >= 2).flatMap((group) => group.slice(0, 2));
    if (pairs.length >= length) out.push(pairs.slice(0, length));
  }
  if (length % 3 === 0) {
    const triples = groups.filter((group) => group.length >= 3).flatMap((group) => group.slice(0, 3));
    if (triples.length >= length) out.push(triples.slice(0, length));
  }
  return out;
}

function findAnyLegalCombination(room, seat, leaderCards, length, pool = seat.hand) {
  const sorted = [...pool].sort((a, b) => cardOrderValue(a, room) - cardOrderValue(b, room));
  const combo = [];
  let checked = 0;
  // Large enough to exhaust a single suit's follows (e.g. C(20,6)≈39k) when called
  // on the small led-suit pool by legalFollow.
  const limit = 80000;
  function search(start) {
    if (checked > limit) return null;
    if (combo.length === length) {
      checked += 1;
      return validatePlay(room, seat, combo, leaderCards).ok ? [...combo] : null;
    }
    for (let i = start; i < sorted.length; i += 1) {
      combo.push(sorted[i]);
      const found = search(i + 1);
      if (found) return found;
      combo.pop();
    }
    return null;
  }
  return search(0);
}

function updateFriend(room, play) {
  if (!room.friendCall || room.friendSeat !== null) return;
  for (const card of play.cards) {
    if (matchesCalledCard(card, room.friendCall)) {
      room.friendCall.seen += 1;
      if (room.friendCall.seen === room.friendCall.ordinal) {
        room.friendSeat = play.seat;
        // 供前端播放“朋友现身”戏剧化动画：seq 单调递增以便检测这一次现身。
        room.friendReveal = { seat: play.seat, seq: (room.friendRevealSeq || 0) + 1 };
        room.friendRevealSeq = room.friendReveal.seq;
        room.tableLog.push(`${seatName(room, play.seat)} 成为朋友。`);
        // Teams are now known — reassign captured points per rule 96.
        recomputeScores(room);
      }
    }
  }
}

function matchesCalledCard(card, call) {
  if (call.rank === "bigJoker" || call.rank === "smallJoker") return card.rank === call.rank;
  return card.rank === call.rank && card.suit === call.suit;
}

function normalizeCalledCard(call) {
  if (call.rank === "bigJoker" || call.rank === "smallJoker") return { rank: call.rank, suit: "joker" };
  if (!SUITS.includes(call.suit)) throw new Error("请选择花色");
  return { rank: String(call.rank), suit: call.suit };
}

function calledCardLabel(call) {
  if (call.rank === "bigJoker") return "大王";
  if (call.rank === "smallJoker") return "小王";
  return `${call.suit}${call.rank}`;
}

export function dealerTeamSeats(room) {
  if (isFixedTeamMode(room)) {
    // 固定隔座队：与庄家同奇偶的座位是一队（4 人 {0,2}/{1,3}；6 人 {0,2,4}/{1,3,5}）。
    const parity = room.dealerSeat % 2;
    return room.seats.map((s) => s.index).filter((i) => i % 2 === parity);
  }
  return room.friendSeat === null || room.friendSeat === room.dealerSeat ? [room.dealerSeat] : [room.dealerSeat, room.friendSeat];
}

function attackerSeats(room) {
  const dealerTeam = new Set(dealerTeamSeats(room));
  return room.seats.map((seat) => seat.index).filter((index) => !dealerTeam.has(index));
}

export function isDealerTeam(room, seatIndex) {
  return dealerTeamSeats(room).includes(seatIndex);
}

function buryMultiplier(room, winPlay) {
  let shape = winPlay?.shape;
  if (!shape) return 2;
  const lockedTriples = lockedTriplesForPlay(room, winPlay);
  if (lockedTriples.length) {
    shape = analyzeShapeWithLockedTriples(winPlay.cards, room, lockedTriples);
  }
  // 甩牌：扣底倍率只按其中“最大的单一牌型”（张数最多的组件）计算，不累加其余组件。
  // 例：复数对子+单张 → 只算一对（×4）；4 张拖拉机+单张+对子+三条 → 只算拖拉机（×16）。
  if (shape.type === "throw") shape = dominantThrowShape(winPlay.cards, room, lockedTriples);
  if (isClassic4(room)) {
    return classic4Mode.buryMultiplierClassic4(shape);
  }
  if (room.mode === MODES.FIXED_TEAM_6) return fixedTeam6Mode.buryMultiplierFixedTeam6(shape);
  return findFriend5Mode.buryMultiplierFindFriend5(shape);
}

export function dominantThrowShape(cards, room, lockedTriples = []) {
  return modeRules(room).dominantThrowShape(cards, room, lockedTriples);
}

function trumpKillSeats(room, plays = room.currentTrick) {
  return modeRules(room).trumpKillSeats(room, plays);
}

function nextSeat(index, seatCount) {
  return (index + 1) % seatCount;
}

// 【完美重构】：真正动态红黑交替的手牌理牌算法
export function sortHand(hand, room, overrideLevel = null) {
  const currentLevel = overrideLevel || room.levelRank || room.firstLevel;
  // Temporarily set levelRank so playSuit/cardOrderValue use the right rank
  const savedLevelRank = room.levelRank;
  const savedTrumpSuit = room.trumpSuit;
  const savedNoTrump = room.noTrump;
  if (overrideLevel) {
    room.levelRank = overrideLevel;
    room.trumpSuit = null;
    room.noTrump = false;
  }

  // 1. 拆分卡牌：先挑出主牌（王、级牌、主花色普通牌）和副牌
  const trumpCards = [];
  const spadeCards = [];
  const heartCards = [];
  const clubCards = [];
  const diamondCards = [];

  for (const card of hand) {
    // 判定是否是主牌
    const isJoker = card.rank === "bigJoker" || card.rank === "smallJoker";
    const isLevel = card.rank === currentLevel;
    const isTrumpSuit = (!room.noTrump && room.trumpSuit && card.suit === room.trumpSuit);

    if (isJoker || isLevel || isTrumpSuit) {
      trumpCards.push(card);
    } else {
      // 纯副牌分类
      if (card.suit === "spades") spadeCards.push(card);
      else if (card.suit === "hearts") heartCards.push(card);
      else if (card.suit === "clubs") clubCards.push(card);
      else if (card.suit === "diamonds") diamondCards.push(card);
    }
  }

  // 2. 主牌区内部排序：大牌靠左
  trumpCards.sort((a, b) => {
    const valA = trumpSortValue(a, room);
    const valB = trumpSortValue(b, room);
    if (valA !== valB) return valA - valB; // 权重小的排前面（最左）
    return a.copy - b.copy;
  });

  // 3. 副牌各个花色内部排序：点数从大到小（A最大，2最小）
  const sortByRank = (a, b) => {
    const order = ["A", "K", "Q", "J", "10", "9", "8", "7", "6", "5", "4", "3", "2"];
    const idxA = order.indexOf(a.rank);
    const idxB = order.indexOf(b.rank);
    if (idxA !== idxB) return idxA - idxB;
    return a.copy - b.copy;
  };
  spadeCards.sort(sortByRank);
  heartCards.sort(sortByRank);
  clubCards.sort(sortByRank);
  diamondCards.sort(sortByRank);

  // 4. 动态构建【红黑相间】的副牌花色顺序
  const blackSuits = []; // 存放有牌的黑色副牌组
  const redSuits = [];   // 存放有牌的红色副牌组

  if (spadeCards.length > 0) blackSuits.push(spadeCards);
  if (clubCards.length > 0) blackSuits.push(clubCards);
  if (heartCards.length > 0) redSuits.push(heartCards);
  if (diamondCards.length > 0) redSuits.push(diamondCards);

  const sideCardsSorted = [];

  // 交叉合并算法：从“组数较多”的颜色开始交替插入。否则当某色花色组更多时
  // （如主花色确认后只剩 1黑2红），多出来的同色组会被挤到一起出现“红红/黑黑”相邻。
  // 从多数色起头可保证在可避免时绝不同色相邻：1黑2红 → 红黑红，2黑1红 → 黑红黑。
  const first  = redSuits.length > blackSuits.length ? redSuits : blackSuits;
  const second = first === redSuits ? blackSuits : redSuits;
  while (first.length > 0 || second.length > 0) {
    if (first.length > 0)  sideCardsSorted.push(...first.shift());
    if (second.length > 0) sideCardsSorted.push(...second.shift());
  }

  // 5. 最终合体：主牌在最左边，绝对动态红黑相间的副牌紧随其后
  const finalHand = [...trumpCards, ...sideCardsSorted];

  // 6. 把排好序的牌写回玩家手牌数组中
  hand.length = 0;
  for (const card of finalHand) {
    hand.push(card);
  }

  // Restore levelRank if we temporarily overrode it
  if (overrideLevel) {
    room.levelRank = savedLevelRank;
    room.trumpSuit = savedTrumpSuit;
    room.noTrump = savedNoTrump;
  }
}

function sortSeatHandForRound(room, seat) {
  const preDealerFindFriend = hasFriendMode(room)
    && room.phase === PHASES.DEALING
    && room.dealing;
  sortHand(seat.hand, room, preDealerFindFriend ? seat.level : null);
}

// 辅助函数：专门计算主牌区内部的绝对大小权重（值越小越靠左）
function trumpSortValue(card, room) {
  const currentLevel = room.levelRank || room.firstLevel;
  
  if (card.rank === "bigJoker") return 0;
  if (card.rank === "smallJoker") return 10;
  
  // 级牌层
  if (card.rank === currentLevel) {
    if (!room.noTrump && room.trumpSuit && card.suit === room.trumpSuit) return 20;
    const order = ["spades", "hearts", "clubs", "diamonds"];
    return 30 + order.indexOf(card.suit);
  }
  
  // 普通主牌
  const rankOrder = ["A", "K", "Q", "J", "10", "9", "8", "7", "6", "5", "4", "3", "2"];
  return 100 + rankOrder.indexOf(card.rank);
}

function seatName(room, seatIndex) {
  return room.seats[seatIndex]?.nickname || `座位${seatIndex + 1}`;
}


// 核心修复：计算卡牌在手牌中的摆放权重（值越小越靠左/前）
function handSortValue(card, room) {
  const currentLevel = room.levelRank || room.firstLevel; // 未定主时，使用本局初始级牌
  
  // 1. 大王
  if (card.rank === "bigJoker") return 0;
  // 2. 小王
  if (card.rank === "smallJoker") return 10;
  
  // 3. 级牌（常主点数，如所有的 2）
  if (card.rank === currentLevel) {
    // 3a. 如果已经确定了主花色，且这张级牌正好处在主花色上（正主级牌，最大）
    if (!room.noTrump && room.trumpSuit && card.suit === room.trumpSuit) return 20;
    // 3b. 其余花色的级牌（副主级牌）
    return 30 + suitSortIndex(card.suit, room);
  }
  
  // 4. 已经定主后的普通主牌（主花色的其他数字）
  if (!room.noTrump && room.trumpSuit && card.suit === room.trumpSuit) {
    return 100 + rankSortIndex(card.rank);
  }
  
  // 5. 普通副牌区（这里引入“红黑相间”的花色交替推荐顺序：黑桃 -> 红桃 -> 梅花 -> 方片）
  return 300 + suitSortIndex(card.suit, room) * 20 + rankSortIndex(card.rank);
}

// 辅助函数：根据当前主牌状态，动态调整花色排序索引
function suitSortIndex(suit, room) {
  // 如果确立了主花色，主花色在主牌区已被拎走。副牌区按 [黑桃, 红桃, 梅花, 方片] 顺次排列实现红黑相间
  // 如果未确定主花色，默认也按此顺序实现红黑相间
  const order = ["spades", "hearts", "clubs", "diamonds"];
  const index = order.indexOf(suit);
  return index >= 0 ? index : 99;
}

// 辅助函数：将牌面字母（A-2）转换为排序索引（A最大，2最小。注意：级牌数字会被上面接管，这里只需处理基础相对大小）
function rankSortIndex(rank) {
  const order = ["A", "K", "Q", "J", "10", "9", "8", "7", "6", "5", "4", "3", "2"];
  const index = order.indexOf(rank);
  return index >= 0 ? index : 99;
}

function pickCards(hand, ids) {
  const set = new Set(ids);
  return hand.filter((card) => set.has(card.id));
}

function removeCards(hand, ids) {
  const set = new Set(ids);
  const removed = [];
  for (let i = hand.length - 1; i >= 0; i -= 1) {
    if (set.has(hand[i].id)) removed.push(hand.splice(i, 1)[0]);
  }
  if (removed.length !== set.size) throw new Error("选牌不在手牌中");
  return removed.reverse();
}

function findSeatByPlayer(room, playerId) {
  return room.seats.find((seat) => seat.playerId === playerId) ?? null;
}

function assertPhase(room, phase) {
  if (room.phase !== phase) throw new Error(`当前阶段不是 ${phase}`);
}



// 下发抢庄信息时剥离敏感字段：playerId 是身份令牌（泄露可被 reconnect 夺座、偷手牌），
// cards 的内部 id 也不外泄；亮出的牌只保留 rank/suit/label 供显示。
function sanitizeBid(bid) {
  if (!bid) return null;
  const { playerId, cards, ...rest } = bid;
  return { ...rest, cards: (cards || []).map((c) => ({ rank: c.rank, suit: c.suit, label: c.label })) };
}

// Viewer-independent slice of the room state. Computed ONCE per broadcast and
// shared (by reference) across every viewer; projectStateForViewer() overlays
// the cheap per-viewer bits (own hand, isYou, viewerSeat, isHost) on top. The
// heavy parts — tricks history mapping, bid sanitising, tableLog slice — used to
// run once per viewer; now they run once per broadcast.
export function buildSharedState(room) {
  return {
    code: room.code,
    phase: room.phase,
    round: room.round,
    starterSeat: room.starterSeat,
    levelRank: room.levelRank,
    trumpSuit: room.trumpSuit,
    noTrump: room.noTrump,
    dealerSeat: room.dealerSeat,
    currentBid: sanitizeBid(room.currentBid),
    seatBids: Object.fromEntries(Object.entries(room.seatBids || {}).map(([k, v]) => [k, sanitizeBid(v)])),
    bidResponses: room.bidResponses,
    dealing: room.dealing,
    revealedKitty: room.revealedKitty,
    forceSpin: room.forceSpin || null,
    friendCall: room.friendCall,
    friendSeat: room.friendSeat,
    mode: room.mode,
    fixedTeams: room.fixedTeams === true,
    seatCount: room.seatCount,
    kittySize: room.kittySize,
    sixTrumpAttempt: room.sixTrumpAttempt || 0,
    friendReveal: room.friendReveal || null,
    // 历史墩（供“本局牌局”回看）。card 精简为 rank/suit/label（省去 id，减小 payload）。
    // 高频广播会带上全部历史；公开高并发部署可改为按需请求（参考 hint 的请求-响应）。
    tricks: (room.finishedTricks || []).map((t) => ({
      winner: t.winner,
      points: t.points,
      plays: t.plays.map((p) => ({ seat: p.seat, shapeLabel: p.shapeLabel || "", cards: p.cards.map((c) => ({ rank: c.rank, suit: c.suit, label: c.label })) }))
    })),
    currentLeader: room.currentLeader,
    turnSeat: room.turnSeat,
    currentTrick: room.currentTrick,
    lastTrick: room.lastTrick,
    lastTrickWin: room.lastTrickWin || null,
    trickPauseUntil: room.trickPauseUntil || 0,
    // 当前这墩已出牌中“最大的一手”所属座位（用于前端实时高亮领先者）。
    currentWinnerSeat: (room.phase === PHASES.PLAYING && room.currentTrick.length > 0)
      ? (() => { try { return determineTrickWinner(room, room.currentTrick); } catch { return null; } })()
      : null,
    trumpKillSeats: (room.phase === PHASES.PLAYING && room.currentTrick.length > 1)
      ? (() => { try { return trumpKillSeats(room, room.currentTrick); } catch { return []; } })()
      : [],
    throwResult: room.throwResult,
    scores: room.scores,
    throwPenaltyStats: room.throwPenaltyStats || { attackers: 0, dealerTeam: 0, netToAttackers: 0 },
    seatPersonalScores: room.seatPersonalScores || {},
    lastResult: room.lastResult,
    matchLog: room.matchLog || [],
    tableLog: room.tableLog.slice(-40),
    seats: room.seats.map((seat) => ({
      index: seat.index,
      // 安全：不下发真实 playerId。它是客户端自报的身份令牌，一旦随广播泄露，任何人都能
      // 用它 reconnect 夺座、偷看手牌。这里只给“是否有人入座”的占位串，前端各处仅做真值
      // 判断；本人由 isYou 单独标识。完整修复见 token 鉴权 TODO：reconnect 应校验服务器
      // 签发的不可猜 token，而非客户端自报的 id。
      playerId: seat.playerId ? "seated" : null,
      nickname: seat.nickname,
      avatar: seat.avatar ?? null,
      level: seat.level,
      connected: seat.connected,
      isAi: seat.isAi === true,
      aiLevel: seat.aiLevel ?? null,
      trustee: seat.trustee === true,
      handCount: seat.hand.length,
      takenTrickPoints: seat.takenTrickPoints,
      isYou: false,
      lockedTriples: [],
      hand: []
    })),
    hiddenKittyCount: room.hiddenKitty.length,
    kittyCount: room.kitty.length,
    spectators: [...(room.spectators?.values() ?? [])]
      .filter((s) => s.connected)
      .map((s) => s.nickname || "游客")
  };
}

// Overlay the per-viewer fields onto a shared base. Cheap: non-viewer seats are
// passed through by reference (never mutated — the result is serialised and sent),
// only the viewer's own seat object is rebuilt with their hand/lockedTriples.
export function projectStateForViewer(shared, room, viewerId = null) {
  const viewerSeat = findSeatByPlayer(room, viewerId);
  const seats = shared.seats.map((s) => {
    const live = room.seats[s.index];
    if (live.playerId !== viewerId) return s;
    return { ...s, isYou: true, hand: live.hand, lockedTriples: live.lockedTriples || [] };
  });
  return {
    ...shared,
    seats,
    viewerSeat: viewerSeat?.index ?? null,
    isHost: room.hostId === viewerId
  };
}

export function publicState(room, viewerId = null) {
  return projectStateForViewer(buildSharedState(room), room, viewerId);
}

export const constants = { PHASES, DEFAULT_SEATS };
