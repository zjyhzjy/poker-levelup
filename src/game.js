import crypto from "node:crypto";
import { cardScore, createDeck, levelAdvance, LEVEL_RANKS, rankNumber, RANKS, shuffle, SUITS } from "./cards.js";

const DEFAULT_SEATS = 5;
// 每人手牌数 = (162 − 底牌)/人数，底牌随人数取整除：5 人留 7 张底（每人 31），
// 6 人留 6 张底（每人 26）。三副牌总分恒为 300，升级分线不随人数变。
function kittyFor(seatCount) { return seatCount === 6 ? 6 : 7; }
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
  const seatCount = options.seatCount === 6 ? 6 : DEFAULT_SEATS;
  return {
    code,
    seatCount,
    kittySize: kittyFor(seatCount),
    fixedTeams: seatCount === 6, // 6 人隔座固定队（{0,2,4} vs {1,3,5}），不叫朋友
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
    friendCall: null,
    friendSeat: null,
    hiddenKitty: [],
    currentLeader: null,
    turnSeat: null,
    currentTrick: [],
    lastTrick: [],
    throwResult: null,   // { seat, allCards, keepCards, failed, message } — cleared after next play
    trickPauseUntil: 0,
    finishedTricks: [],
    tableLog: [],
    scores: { attackers: 0, dealerTeam: 0 },
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
  if (typeof avatar === "string" && avatar.trim()) seat.avatar = avatar.trim().slice(0, 8);
  seat.connected = true;
  seat.isAi = false;
  seat.trustee = false;
  room.spectators.delete(playerId);
}

export function addAiPlayer(room, seatIndex, aiLevel = "medium") {
  assertPhase(room, PHASES.LOBBY);
  const seat = room.seats[seatIndex];
  if (!seat) throw new Error("座位不存在");
  if (seat.playerId) throw new Error("这个座位已经有人了");
  const level = AI_PROFILES[aiLevel] ? aiLevel : "medium";
  const tag = { easy: "弱", medium: "中", hard: "强" }[level];
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
  if (room.fixedTeams) {
    // 6 人固定队：首轮先抢庄；之后按上局结果确定本轮庄家。
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
  room.friendCall = null;
  room.friendSeat = null;
  room.hiddenKitty = [];
  room.currentTrick = [];
  room.lastTrick = [];
  room.lastTrickWin = null;
  room.trickPauseUntil = 0;
  room.friendReveal = null;
  room.throwResult = null;
  room.finishedTricks = [];
  room.scores = { attackers: 0, dealerTeam: 0 };
  room.seatPersonalScores = {};
  room.lastResult = null;
  room.tableLog = [];
  room.kitty = [];
  room.deck = shuffle(createDeck(), random);
  room.phase = PHASES.DEALING;
  room.starterSeat = room.fixedTeams
    ? (room.dealerSeat ?? Math.floor(random() * room.seatCount))
    : (firstRound ? Math.floor(random() * room.seatCount) : nextSeat(room.starterSeat, room.seatCount));
  room.currentLeader = room.starterSeat;
  room.turnSeat = room.starterSeat;
  for (const seat of room.seats) {
    seat.hand = [];
    seat.takenTrickPoints = 0;
    seat.lockedTriples = []; // 本局内被“锁定”的三条（不可再拆成对子出）
    if (room.fixedTeams) seat.level = room.teamLevels[seat.index % 2]; // 6人=所属队共享等级
    else if (firstRound) seat.level = room.firstLevel;
  }

  room.tableLog.push(`本轮从 ${seatName(room, room.starterSeat)} 开始逆时针摸牌。`);
  room.tableLog.push(room.fixedTeams
    ? `【系统】本局游戏开始！6 人局发完牌后叫主${room.dealerSeat === null ? "抢庄" : "，庄家不变"}。`
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
  for (const seat of room.seats) sortHand(seat.hand, room, seat.level);
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
    // Someone bid during the deal — now that the kitty exists we can resolve it.
    _checkAllBidResponded(room);
    return;
  }
  if (room.phase === PHASES.DEALING) {
    if (room.fixedTeams) {
      startSixTrumpCalling(room);
    } else {
      room.phase = PHASES.AUCTION_READY;
      room.tableLog.push("摸牌结束无人亮主，等待手动开始翻底拍卖。");
    }
  }
}

export function makeBid(room, playerId, cardIds) {
  if (![PHASES.DEALING, PHASES.AUCTION_READY, PHASES.AUCTION].includes(room.phase)) throw new Error("现在不能抢庄");
  const seat = findSeatByPlayer(room, playerId);
  if (!seat) throw new Error("请先入座");
  const cards = pickCards(seat.hand, cardIds);
  const bid = evaluateBid(cards, seat.level);
  if (!bid) throw new Error("只能亮自己的常主牌，或任意 3 张王");
  if (room.currentBid && compareBid(bid, room.currentBid) <= 0) throw new Error("必须用更高强度抢庄");
  room.currentBid = { ...bid, seat: seat.index, playerId, cards };
  // 盖庄后其他座位需对更高的庄重新表态：清空旧的亮牌与响应，只保留本次亮庄者。
  // 否则 _checkAllBidResponded 会把陈旧的 pass/bid 计入而提前定庄，跳过被盖者再抢。
  room.seatBids = { [seat.index]: { ...bid, cards } };
  room.bidResponses = { [seat.index]: "bid" };
  room.dealerSeat = seat.index;
  room.levelRank = bid.levelRank;
  room.noTrump = bid.noTrump;
  room.trumpSuit = bid.trumpSuit;
  room.tableLog.push(`${seat.nickname} 亮庄：${cards.map((c) => c.label).join("、")}`);
  // Never confirm immediately — always let broadcast fire first so the bid card
  // is visible on the table. confirmDealer will be triggered by _checkAllBidResponded
  // once everyone has responded, or by scheduleBidTimeout after 10s.
  _checkAllBidResponded(room);
}

export function passBid(room, playerId) {
  if (![PHASES.DEALING, PHASES.AUCTION_READY, PHASES.AUCTION].includes(room.phase)) throw new Error("现在不能操作");
  if (!room.currentBid) throw new Error("还没有人亮庄，无需操作");
  const seat = findSeatByPlayer(room, playerId);
  if (!seat) throw new Error("请先入座");
  if (room.bidResponses[seat.index]) throw new Error("你已经响应过了");
  room.bidResponses[seat.index] = "pass";
  room.tableLog.push(`${seat.nickname} 不抢。`);
  _checkAllBidResponded(room);
}

function _checkAllBidResponded(room) {
  if (!room.currentBid) return;
  if (room.dealing) return; // wait until all cards are dealt before confirming
  const totalSeats = room.seats.filter((s) => s.playerId).length;
  const responded = Object.keys(room.bidResponses).length;
  if (responded >= totalSeats) {
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
  for (const seat of room.seats) sortHand(seat.hand, room, seat.level);
  if (room.dealerSeat === null) {
    room.tableLog.push(`首轮抢庄：所有人可亮自己的 ${room.levelRank} 定主，亮主者坐庄。`);
  } else {
    room.tableLog.push(`${seatName(room, room.dealerSeat)} 坐庄（打 ${room.levelRank}），所有人可亮 ${room.levelRank} 定主，庄家不变。`);
  }
}

function evaluateSixTrumpCall(cards, levelRank) {
  if (!cards.length) return null;
  if (cards.some((card) => card.suit === "joker")) return null;
  if (!cards.every((card) => card.rank === levelRank && card.suit === cards[0].suit)) return null;
  if (!SUITS.includes(cards[0].suit)) return null;
  return {
    strength: Math.min(cards.length, 3),
    levelRank,
    trumpSuit: cards[0].suit,
    noTrump: false
  };
}

export function callSixTrump(room, playerId, cardIds) {
  assertPhase(room, PHASES.SIX_TRUMP);
  const seat = findSeatByPlayer(room, playerId);
  if (!seat) throw new Error("请先入座");
  if (room.bidResponses[seat.index]) throw new Error("你已经响应过了");
  const openingAuction = room.sixFirstAuction === true;
  const levelRank = openingAuction ? seat.level : room.levelRank;
  const cards = pickCards(seat.hand, cardIds);
  const bid = evaluateSixTrumpCall(cards, levelRank);
  if (!bid) throw new Error(`只能亮当前等级 ${levelRank} 的同花色牌`);
  if (room.currentBid && compareBid(bid, room.currentBid) <= 0) throw new Error("必须用更多张同花色级牌盖主");

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
  room.trumpSuit = bid.trumpSuit;
  room.noTrump = false;
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
      sortHand(seat.hand, room, seat.level);
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
  room.friendCall = null;
  room.friendSeat = null;
  room.hiddenKitty = [];
  room.currentTrick = [];
  room.lastTrick = [];
  room.lastTrickWin = null;
  room.friendReveal = null;
  room.throwResult = null;
  room.finishedTricks = [];
  room.scores = { attackers: 0, dealerTeam: 0 };
  room.seatPersonalScores = {};
  room.lastResult = null;
  room.kitty = [];
  room.deck = shuffle(createDeck(), Math.random);
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
  if (![PHASES.DEALING, PHASES.AUCTION_READY, PHASES.AUCTION].includes(room.phase)) return;
  if (room.dealing) return; // cards still being dealt; kitty not ready yet
  room.dealerSeat = room.currentBid.seat;
  room.levelRank = room.currentBid.levelRank;
  room.trumpSuit = room.currentBid.trumpSuit;
  room.noTrump = room.currentBid.noTrump;
  giveKittyToDealer(room);
}

export function forceDealer(room, lastKittyCard) {
  // 从第一个摸牌玩家(starterSeat)开始，按逆时针(nextSeat，与摸牌/出牌方向一致)数人。
  // 点数映射位置：A=1(starterSeat 自己)、2=第2个、… K=13、王=14/15。
  const count = forceCount(lastKittyCard); // 1 for A/jokers, number for 2-K
  let seatIndex = room.starterSeat;
  for (let i = 1; i < count; i += 1) seatIndex = nextSeat(seatIndex, room.seatCount);
  const dealer = room.seats[seatIndex];
  room.dealerSeat = seatIndex;
  room.levelRank = dealer.level;
  // Jokers force noTrump; otherwise default to last kitty card's suit
  const isJoker = lastKittyCard.suit === "joker";
  room.noTrump = isJoker;
  room.trumpSuit = isJoker ? null : lastKittyCard.suit;
  room.currentBid = { seat: seatIndex, playerId: dealer.playerId, strength: 0, levelRank: dealer.level, trumpSuit: room.trumpSuit, noTrump: room.noTrump };
  room.seatBids = {};
  room.bidResponses = {};
  room.phase = PHASES.FORCED_SUIT;
  room.tableLog.push(`${dealer.nickname} 被强制坐庄，可选择是否亮自己的常主花色改主。`);
  for (const seat of room.seats) {
    sortHand(seat.hand, room);
  }
}

function prevSeat(index, seatCount) {
  return (index + seatCount - 1) % seatCount;
}

export function chooseForcedTrump(room, playerId, suit = null, options = {}) {
  assertPhase(room, PHASES.FORCED_SUIT);
  const dealer = findSeatByPlayer(room, playerId);
  if (!dealer || dealer.index !== room.dealerSeat) throw new Error("只有强制庄家可以定主花色");
  if (options.noTrump) {
    const cards = pickCards(dealer.hand, options.cardIds || []);
    if (cards.length !== 3 || !cards.every((card) => card.suit === "joker")) throw new Error("亮无主需要选择 3 张王");
    room.noTrump = true;
    room.trumpSuit = null;
    if (room.currentBid) { room.currentBid.noTrump = true; room.currentBid.trumpSuit = null; }
    sortHand(dealer.hand, room);
    room.tableLog.push(`${dealer.nickname} 亮 3 张王，强制定为无主。`);
    giveKittyToDealer(room);
    return;
  }
  if (suit && !SUITS.includes(suit)) throw new Error("花色不存在");
  if (suit) {
    const hasLevelCard = dealer.hand.some((card) => card.rank === room.levelRank && card.suit === suit);
    // 6 人轮庄的庄家由轮转指定（非抢来），有权直接定主，不要求手里有该花色级牌。
    if (!hasLevelCard && !room.fixedTeams) throw new Error(`你手里没有 ${suit} 的级牌，不能亮此花色`);
    room.trumpSuit = suit;
    room.noTrump = false;
    if (room.currentBid) { room.currentBid.trumpSuit = suit; room.currentBid.noTrump = false; }
  }
  // If suit is null: keep whatever noTrump/trumpSuit forceDealer already set
  sortHand(dealer.hand, room);
  const suitLabel = room.noTrump ? "无主" : (room.trumpSuit || "未知");
  room.tableLog.push(`${dealer.nickname} 确认主花色：${suitLabel}`);
  giveKittyToDealer(room);
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
  sortHand(dealer.hand, room);
  if (room.fixedTeams) {
    // 6 人固定队：无需叫朋友，扣底后直接开打（隔座为友）。
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
  const cards = pickCards(seat.hand, cardIds);
  if (!cards.length) throw new Error("请选择要出的牌");
  const leaderPlay = room.currentTrick[0]?.cards ?? null;

  // Clear previous throwResult whenever a new card is played
  room.throwResult = null;

  const shape = analyzeShape(cards, room);
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
    const play = { seat: seat.index, cards, shape, points: cards.reduce((sum, card) => sum + cardScore(card), 0) };

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
      const keepPlay = { seat: seat.index, cards: keepCards, shape: analyzeShape(keepCards, room), points: keepCards.reduce((sum, card) => sum + cardScore(card), 0) };
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
    const play = { seat: seat.index, cards, shape, points: cards.reduce((sum, card) => sum + cardScore(card), 0) };
    room.currentTrick.push(play);
    updateFriend(room, play);
    room.tableLog.push(`${seat.nickname} 出牌：${cards.map((card) => card.label).join("、")}`);
  }

  if (room.currentTrick.length === room.seatCount) {
    finishTrick(room);
  } else {
    room.turnSeat = nextSeat(room.turnSeat, room.seatCount);
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
  // otherwise the 2s/5s/10s timers get bypassed instantly.
  if ([PHASES.DEALING, PHASES.AUCTION_READY, PHASES.AUCTION, PHASES.SIX_TRUMP].includes(room.phase)) {
    return false;
  }

  if (room.phase === PHASES.FORCED_SUIT && isAutoSeat(room, room.dealerSeat)) {
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

// 推荐出牌：用 AI 逻辑算出当前应出的牌，返回 cardId 数组（仅在轮到该玩家出牌时）。
export function recommendPlay(room, playerId) {
  if (room.phase !== PHASES.PLAYING) return null;
  const seat = room.seats.find((s) => s.playerId === playerId);
  if (!seat || seat.index !== room.turnSeat) return null;
  const leaderCards = room.currentTrick[0]?.cards ?? null;
  const cards = chooseAiPlay(room, seat, leaderCards) || [];
  return cards.map((card) => card.id);
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
  easy:   { contest: true, feed: true, pull: false, voidDiscard: false, riskAware: false, bidRatio: 0.62, temp: 1.6  },
  medium: { contest: true, feed: true, pull: true,  voidDiscard: true,  riskAware: false, bidRatio: 0.50, temp: 0.55 },
  hard:   { contest: true, feed: true, pull: true,  voidDiscard: true,  riskAware: true,  bidRatio: 0.42, temp: 0.12 }
};
export function aiProfile(seat) {
  return AI_PROFILES[seat?.aiLevel] || AI_PROFILES.medium;
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
      if (follow) return follow;
    }
  } catch (_) { /* fall through to the safe baseline */ }
  return safeAiPlay(room, seat, leaderCards);
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
  // 固定队（6人）队伍从一开始就已知；找朋友（5人）则朋友亮明后才确定。
  if (room.fixedTeams || room.friendSeat !== null) {
    const team = dealerTeamSeats(room);
    return team.includes(selfIndex) === team.includes(otherIndex) ? "ally" : "enemy";
  }
  if (otherIndex === room.dealerSeat) return "enemy";
  return "unknown";
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
  const myPlay = { seat: seat.index, cards, shape: analyzeShape(cards, room), points: 0 };
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
  const beats = candidateBeats(room, seat, cards);
  const cost = cards.reduce((sum, c) => sum + spendCost(c, room), 0);
  const pts = cards.reduce((sum, c) => sum + cardScore(c), 0);
  let u = -cost * 0.5;

  // Partner holds the trick.
  if (stand.rel === "ally") {
    const allyBoss = stand.winnerRuffed || isComboBoss(room, seat, stand.winnerCards, seen);
    if (stand.isLast || allyBoss) {                 // securely winning → pour points in / keep low
      if (profile.feed) u += pts * 2.5;
      else u -= pts * 0.2;
      return u;
    }
    // 3rd-hand-high: ally winning but beatable and an enemy still acts behind me.
    // Secure the team's points — but ONLY with a guaranteed boss, never a card the
    // next player could beat, so I never waste a losable card on my own partner.
    if (beats && stand.points > 0 && enemyBehind(room, seat) && isComboBoss(room, seat, cards, seen)) {
      u += stand.points * 1.5 + 1;
    } else {
      u -= pts * 0.2;
    }
    return u;
  }

  // An enemy / unknown holds the trick.
  if (beats) {
    if (!profile.contest) { u -= 100; return u; } // easy never goes out of its way to win
    let reward = (stand.points * 2 + 1) * (1 + 0.2 * (seat.aiBias ?? 0)); // +personality
    if (profile.riskAware && !stand.isLast) {       // win isn't secured if others still act
      reward *= 0.5;
      u -= pts * 1.0;                               // and my own points could be overtaken
      if (allyBehind(room, seat)) reward *= 0.4;    // a teammate can still take it — duck
    }
    u += reward;
  } else {
    u -= pts * 3.5;                                 // never gift points to enemies/unknowns
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
  const preferredSingle = preferredSingleFollow(room, seat, leaderCards);
  if (preferredSingle && validatePlay(room, seat, preferredSingle, leaderCards).ok) return preferredSingle;
  const cands = followCandidates(room, seat, leaderCards);
  if (!cands.length) return null;
  const stand = trickStanding(room, seat);
  const seen = seenCounts(room, seat);
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
  const head = [...cards].sort((a, b) => cardOrderValue(b, room) - cardOrderValue(a, room))[0];
  const isTrump = playSuit(head, room) === "trump";
  const pts = cards.reduce((s, c) => s + cardScore(c), 0);
  const len = cards.length;
  const boss = isComboBoss(room, seat, cards, seen);

  // Non-point low single = the probe: pick it only when nothing is worth cashing.
  if (len === 1 && !boss && cardScore(head) === 0) return 0.5 - cardOrderValue(head, room) * 0.01;
  // A non-boss high card / combo can be beaten or ruffed — don't throw it away.
  if (!boss) return -5 - cardOrderValue(head, room) * 0.01 - len;

  // Boss combo: cash a guaranteed winner — bank points, clear cards, apply pressure.
  let u = 3 + pts * 3 + len * 1.5;
  if (isTrump) {
    // Declarer pulls trump from strength (basic). easy doesn't manage trump, so it
    // doesn't get the pull bonus and leaves its trump back.
    if (seat.index === room.dealerSeat && profile.pull) u += 4 + len;
    else u -= 2;
  } else if (len === 1 && pts === 0) {
    // Cashing a bare side ace is basic, but it risks a ruff once the suit dries up
    // or an opponent is known void — back off then (all levels read this much).
    const ruffable = enemyVoidIn(room, seat, head.suit) || suitPlayed(room, head.suit) > 8;
    if (ruffable) u -= 4;
  }
  return u;
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
  for (const seat of room.seats) {
    if (isDealerTeam(room, seat.index)) dealerTeam += seat.takenTrickPoints;
    else attackers += seat.takenTrickPoints;
  }
  // Failed-throw penalties: the thrower's team loses 10. Expressed as an attacker
  // delta (dealer-team penalty benefits the attackers, attacker penalty reduces them).
  for (const [idxStr, penalty] of Object.entries(room.seatPersonalScores || {})) {
    if (penalty >= 0) continue;
    const idx = Number(idxStr);
    if (isDealerTeam(room, idx)) attackers += Math.abs(penalty);
    else attackers += penalty;
  }
  room.scores = { attackers: Math.max(0, attackers), dealerTeam };
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
  if (room.seats.every((seat) => seat.hand.length === 0)) {
    finishRound(room, winner);
    return;
  }
  room.currentLeader = winner;
  room.turnSeat = winner;
  room.trickPauseUntil = Date.now() + 1000;
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
    buriedBonus = kittyPoints * buryMultiplier(room.finishedTricks.at(-1)?.plays.find((play) => play.seat === lastWinner)?.shape);
    room.scores.attackers += buriedBonus;
  }
  const attackers = room.scores.attackers;
  const result = room.fixedTeams ? upgradeResultSix(attackers) : upgradeResult(attackers);
  const upgradedSeats = result.steps > 0
    ? (result.side === "dealer" ? dealerTeamSeats(room) : attackerSeats(room))
    : [];
  // 通关：升级方若已在 A 上还要再升（越过 A），即夺冠。
  let champion = null;
  if (room.fixedTeams) {
    // 6 人轮庄：升级赢队的共享等级；并决定下局坐庄（庄家队守住→连庄、轮到隔座队友；
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
  room.lastResult = { attackers, buriedBonus, result, upgradedSeats, champion };
  // 战绩：累积每局结果，供“战绩”面板展示。
  (room.matchLog ||= []).push({
    round: room.round, attackers, label: result.label,
    dealerSeat: room.dealerSeat, friendSeat: room.friendSeat,
    champion, levels: room.seats.map((s) => s.level)
  });
  room.phase = PHASES.ROUND_OVER;
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
  if (!cards.length) return null;
  if (cards.length === 3 && cards.every((card) => card.suit === "joker")) {
    const bigs = cards.filter((card) => card.rank === "bigJoker").length;
    return { strength: bigs >= 2 ? 5 : 4, levelRank: playerLevel, trumpSuit: null, noTrump: true };
  }
  if (!cards.every((card) => card.rank === playerLevel && card.suit !== "joker")) return null;
  if (!cards.every((card) => card.suit === cards[0].suit)) return null;
  if (![1, 2, 3].includes(cards.length)) return null;
  return { strength: cards.length, levelRank: playerLevel, trumpSuit: cards[0].suit, noTrump: false };
}

export function compareBid(a, b) {
  return a.strength - b.strength;
}

// 核心修复：精准分析手牌结构，严格划分拖拉机、对子与甩牌
export function analyzeShape(cards, room) {
  if (cards.length === 0) return { type: "empty", unit: 0, value: 0 };

  const sorted = [...cards].sort((a, b) => cardOrderValue(b, room) - cardOrderValue(a, room));
  const groups = groupCards(sorted);

  // 1. 如果全是单张
  if (groups.every(g => g.length === 1)) {
    if (cards.length === 1) return { type: "single", unit: 1, value: cardOrderValue(cards[0], room) };
    return { type: "throw", unit: 1, value: 0 };
  }

  // 2. 检查是否是纯正的【对子】或【三条】
  const firstLen = groups[0].length;
  if (groups.every(g => g.length === firstLen)) {
    if (groups.length === 1) {
      return { 
        type: firstLen === 2 ? "pair" : "triple", // 兼容旧命名，改为 "triple"
        unit: firstLen, 
        value: cardOrderValue(groups[0][0], room) 
      };
    }
    
    // 如果有多个对子或多个三条，检查它们在动态牌序中是否构成【无缝拖拉机】
    if (isTrueTractor(groups, room)) {
      return { 
        type: "tractor", 
        unit: firstLen, 
        count: groups.length, 
        value: cardOrderValue(groups[0][0], room) // 拖拉机车头权重
      };
    }
  }

  // 3. 不符合标准单牌、单对、单三条或标准拖拉机的，一律打回为“甩牌”
  return { type: "throw", unit: 0, value: 0 };
}

// 核心修复：真正符合升级精髓的“无缝动态拖拉机”判定算法
function isTrueTractor(groups, room) {
  // 必须全部是对子(len=2)或者全是三条(len=3)
  const unitLen = groups[0].length;
  if (unitLen < 2) return false;

  // 获取这手牌的整体花色
  const ledSuit = playSuit(groups[0][0], room);

  // 遍历检查相邻两个组合之间在规则上是否“无缝连续”
  for (let i = 0; i < groups.length - 1; i++) {
    const cardA = groups[i][0];   // 较大的一组牌
    const cardB = groups[i+1][0]; // 较小的一组牌

    if (!isConsecutiveInRules(cardA, cardB, ledSuit, room)) {
      return false;
    }
  }
  return true;
}

// 裁判机：判定在当前定主状态下，两张牌在同一个花色序列里是否绝对紧邻
function isConsecutiveInRules(cardA, cardB, ledSuit, room) {
  const valA = cardOrderValue(cardA, room);
  const valB = cardOrderValue(cardB, room);
  
  // 基础硬性条件：前面的牌必须比后面的牌大
  if (valA <= valB) return false;

  const level = room.levelRank;

  // --- 情况 A：如果是副牌序列（比如你打出的梅花 1010JJ） ---
  if (ledSuit !== "trump") {
    // 升级铁律：级牌Q飞走了，那么在副牌里 K 和 J 是直接相邻的，10 和 J 也是直接相邻的！
    const order = ["A", "K", "Q", "J", "10", "9", "8", "7", "6", "5", "4", "3", "2"];
    // 抽离级牌后的纯净副牌链
    const cleanOrder = order.filter(r => r !== level);
    
    const idxA = cleanOrder.indexOf(cardA.rank);
    const idxB = cleanOrder.indexOf(cardB.rank);
    
    // 如果在抽离级牌后的序列里索引正好相差1（例如 J 和 10），则是完美的副牌拖拉机
    return (idxB - idxA === 1);
  }

  // --- 情况 B：如果是复杂的主牌序列（大小王、正副级牌、主花色普通牌） ---
  // 主牌的绝对连续链条严格如下：
  // 大王 -> 小王 -> 正主级牌 -> 副主级牌(按出牌顺序或特定) -> 主花色A -> 主花色K -> 主花色J (跳过级牌)
  
  // 我们可以通过在当前主牌权重池中找“断层间距”来暴力判定：
  // 拿到 cardA 的权重，看看主牌中仅次于 cardA 的“下一张合法的牌”的权重是多少
  const nextValidValue = getNextImmediateTrumpValue(valA, room);
  return (valB === nextValidValue);
}

// 辅助裁判：获取主牌中紧随其后的下一个合法权重阶梯（封杀 AI2 的非法Q+A连对）
function getNextImmediateTrumpValue(currentValue, room) {
  // 建立一个本局所有可能出现在主牌中的单张核心权重快照
  const sampleTrumpValues = [];
  
  // 1. 王牌
  sampleTrumpValues.push(1000); // 大王
  sampleTrumpValues.push(990);  // 小王
  // 2. 级牌
  sampleTrumpValues.push(980);  // 正主级牌 (如方片Q)
  sampleTrumpValues.push(970);  // 副主级牌 (如红桃/黑桃/梅花Q)
  
  // 3. 普通主牌数字链（抽离级牌后的 A, K, J, 10...）
  const order = ["A", "K", "Q", "J", "10", "9", "8", "7", "6", "5", "4", "3", "2"];
  order.forEach(rank => {
    if (rank !== room.levelRank) {
      sampleTrumpValues.push(500 + rankNumber(rank));
    }
  });

  // 排序并找出正好小于当前权重的下一个最大值
  const sortedValues = [...new Set(sampleTrumpValues)].sort((a, b) => b - a);
  const currentIndex = sortedValues.indexOf(currentValue);
  
  if (currentIndex !== -1 && currentIndex < sortedValues.length - 1) {
    return sortedValues[currentIndex + 1];
  }
  return -1;
}


export function validatePlay(room, seat, cards, leaderCards) {
  // 三条锁定：若本局某副三条曾在“可不拆”的选择时刻被保留（没拆），则之后
  // 不能再把它拆成对子出。领牌永不强制，故直接拒绝；跟牌时只在“竞争性场合”
  // （同门跟牌、或全主牌杀副牌）判违规——普通垫牌里两张同点牌不构成“拆对”。
  // 同时凡是“别无他法”（避开锁定对就凑不齐张数）一律放行，保证任何局面
  // 都存在至少一种合法出牌，杜绝规则死锁。
  const lockedKey = lockedPairViolation(seat, cards, room);
  if (lockedKey) {
    if (!leaderCards) {
      return { ok: false, reason: "这副三条已锁定，不能拆成对子出（可整体出三条或拆成单张）" };
    }
    const [lr, ls] = lockedKey.split("|");
    const ledSuitForLock = playSuit(leaderCards[0], room);
    const lockedSuit = playSuit({ rank: lr, suit: ls }, room);
    const availForLock = seat.hand.filter((c) => playSuit(c, room) === ledSuitForLock);
    const lockedInHand = seat.hand.filter((c) => c.rank === lr && c.suit === ls).length;
    // 竞争性场合：锁定对属于领出花色（同门跟牌），或副牌领出时整手全为主牌（杀牌）。
    const competitive = lockedSuit === ledSuitForLock
      || (ledSuitForLock !== "trump" && lockedSuit === "trump" && cards.every((c) => playSuit(c, room) === "trump"));
    // 别无他法（任一成立即放行）：
    //  - 手里非锁定牌不足以凑齐张数；
    //  - 锁定对属于领出花色且该门牌被迫全部打出；
    //  - 该门可出的牌全部属于这副被锁三条。
    const forced = (seat.hand.length - lockedInHand) < leaderCards.length
      || (lockedSuit === ledSuitForLock && availForLock.length <= leaderCards.length)
      || (availForLock.length > 0 && availForLock.every((c) => c.rank === lr && c.suit === ls));
    if (competitive && !forced) {
      return { ok: false, reason: "这副三条已锁定，不能拆成对子出（请改出单张）" };
    }
  }

  if (!leaderCards) {
    // 作为首出牌者，如果选择了甩牌 (Throw)
    const shape = analyzeShape(cards, room);
    if (shape.type === "throw") {
      // 甩牌必须是同一门花色（或全部主牌）——不允许混花色甩牌。
      const ledSuit = playSuit(cards[0], room);
      if (!cards.every((card) => playSuit(card, room) === ledSuit)) {
        return { ok: false, reason: "甩牌必须是同一门花色（或全部主牌）" };
      }
      return validateThrow(room, seat, cards);
    }
    return { ok: true };
  }
  
  if (cards.length !== leaderCards.length) return { ok: false, reason: "必须出相同张数" };
  
  const ledSuit = playSuit(leaderCards[0], room);
  const available = seat.hand.filter((card) => playSuit(card, room) === ledSuit);
  const following = cards.filter((card) => playSuit(card, room) === ledSuit);
  
  if (available.length >= cards.length && following.length !== cards.length) return { ok: false, reason: "有同门牌时必须跟同门" };
  if (available.length < cards.length && following.length !== available.length) return { ok: false, reason: "同门牌不足时要尽量跟完" };
  
  const leaderShape = analyzeShape(leaderCards, room);

  // Special case: leader played a throw — validate each atomic group independently
  if (leaderShape.type === "throw" && following.length === cards.length) {
    return validateThrowFollow(room, seat, cards, leaderCards, ledSuit, available);
  }

  if (following.length === cards.length) {
    const wanted = forcedRequirement(leaderShape, available, room, seat.lockedTriples || []);
    const actual = analyzeShape(cards, room);
    const followingSameSuit = cards.filter((c) => playSuit(c, room) === ledSuit);
    if (!shapeSatisfies(actual, wanted, followingSameSuit, available, room)) {
      return { ok: false, reason: "需要优先跟同类牌型" };
    }
  }
  return { ok: true };
}

// When following a throw, each atomic group in the leader's throw must be matched
// with the best same-size group the follower can produce from same-suit cards.
function validateThrowFollow(room, seat, cards, leaderCards, ledSuit, available) {
  const leaderSorted = [...leaderCards].sort((a, b) => cardOrderValue(b, room) - cardOrderValue(a, room));
  const leaderGroups = groupCards(leaderSorted); // e.g. [[A,A,A],[Q,Q],[J]]

  // Build what follower MUST contribute per group
  let mustPairs = 0;    // number of pairs required
  let mustTriples = 0;  // number of triples required
  let mustSingles = 0;  // number of singles required

  const availGroups = groupCards([...available].sort((a, b) => cardOrderValue(b, room) - cardOrderValue(a, room)));
  // 锁定的三条不能拆成对子出，不计入“可用对子”（计入会与锁定规则冲突造成死锁）；
  // 整组三张打出不算拆对，所以三条数照常统计。
  const lockedSet = new Set(seat.lockedTriples || []);
  const isLockedGroup = (g) => lockedSet.has(`${g[0].rank}|${g[0].suit}`);
  const availPairs   = availGroups.filter(g => g.length >= 2 && !isLockedGroup(g)).length;
  const availTriples = availGroups.filter(g => g.length >= 3).length;
  const playedSameSuit = cards.filter(c => playSuit(c, room) === ledSuit);

  // 甩牌里如果包含拖拉机组件，跟家手里有对应拖拉机时必须优先跟拖拉机；
  // 不能只用散对子凑数量（例如首家 7788，跟家有 991010 时不能出 9944）。
  const components = decomposeThrowComponents(leaderCards, room, ledSuit);
  for (const comp of components) {
    if (comp.kind !== "tractor") continue;
    const need = comp.unit * comp.count;
    const pool = comp.unit === 2
      ? available.filter((c) => !lockedSet.has(`${c.rank}|${c.suit}`))
      : available;
    if (findTractors(pool, room, need).length && !findTractors(playedSameSuit, room, need).length) {
      return { ok: false, reason: "需要优先跟拖拉机" };
    }
  }

  for (const lg of leaderGroups) {
    if (lg.length >= 3) {
      // Needs a triple; fall back to pair, then single
      if (availTriples > mustTriples) mustTriples++;
      else if (availPairs > mustPairs) mustPairs++;
      else mustSingles++;
    } else if (lg.length === 2) {
      if (availPairs > mustPairs) mustPairs++;
      else mustSingles += 2;
    } else {
      mustSingles++;
    }
  }

  // Check follower's actual played cards satisfy the requirement
  const playedGroups = groupCards([...playedSameSuit].sort((a, b) => cardOrderValue(b, room) - cardOrderValue(a, room)));
  const playedPairs   = playedGroups.filter(g => g.length >= 2).length;
  const playedTriples = playedGroups.filter(g => g.length >= 3).length;

  if (playedTriples < mustTriples) return { ok: false, reason: `需要出 ${mustTriples} 个三条跟甩牌` };
  if (playedPairs   < mustPairs)   return { ok: false, reason: `需要出 ${mustPairs} 对跟甩牌` };

  return { ok: true };
}

// 【彻底修复 3】：精准拆解甩牌组合，防止非对应牌型发生阻挡误判
// Decompose a throw into its structural components: tractors (≥2 consecutive
// same-size groups), standalone pairs/triples, and singles. This is the crux of
// correct throw validation — a pair that is part of a tractor (e.g. the 1010 in
// JJ1010) must be beaten by a bigger TRACTOR, not merely by a higher lone pair.
function decomposeThrowComponents(cards, room, ledSuit) {
  const sorted = [...cards].sort((a, b) => cardOrderValue(b, room) - cardOrderValue(a, room));
  const groups = groupCards(sorted);
  const components = [];
  let i = 0;
  while (i < groups.length) {
    const g = groups[i];
    if (g.length >= 2) {
      let j = i;
      const run = [g];
      while (
        j + 1 < groups.length &&
        groups[j + 1].length === g.length &&
        isConsecutiveInRules(groups[j][0], groups[j + 1][0], ledSuit, room)
      ) {
        run.push(groups[j + 1]);
        j++;
      }
      if (run.length >= 2) {
        components.push({ kind: "tractor", unit: g.length, count: run.length, cards: run.flat() });
        i = j + 1;
        continue;
      }
      components.push({ kind: "group", unit: g.length, count: 1, cards: g });
      i++;
    } else {
      components.push({ kind: "single", unit: 1, count: 1, cards: g });
      i++;
    }
  }
  return components;
}

// Does an opponent's same-suit hand hold a tractor of unit≥`unit`, length≥`count`,
// whose head outranks `headValue`? Only such a tractor can block a thrown tractor.
function opponentHasBetterTractor(otherSameSuit, room, unit, count, headValue, ledSuit) {
  const oGroups = groupCards(
    [...otherSameSuit].sort((a, b) => cardOrderValue(b, room) - cardOrderValue(a, room))
  );
  let i = 0;
  while (i < oGroups.length) {
    if (oGroups[i].length >= unit) {
      let j = i;
      const run = [oGroups[i]];
      while (
        j + 1 < oGroups.length &&
        oGroups[j + 1].length >= unit &&
        isConsecutiveInRules(oGroups[j][0], oGroups[j + 1][0], ledSuit, room)
      ) {
        run.push(oGroups[j + 1]);
        j++;
      }
      if (run.length >= count && cardOrderValue(run[0][0], room) > headValue) return true;
      i = j + 1;
    } else {
      i++;
    }
  }
  return false;
}

// Returns { ok, reason, blockedGroup } — blockedGroup is the SMALLEST component beaten,
// which is exactly the set of cards the thrower must keep after a failed throw.
function validateThrow(room, throwerSeat, cards) {
  const ledSuit = playSuit(cards[0], room);
  const components = decomposeThrowComponents(cards, room, ledSuit);

  const allBlocked = []; // { cards, headValue, reason }

  for (const otherSeat of room.seats) {
    if (otherSeat.index === throwerSeat.index) continue;
    const otherSameSuit = otherSeat.hand.filter((c) => playSuit(c, room) === ledSuit);
    if (otherSameSuit.length === 0) continue;
    const oGroups = groupCards(
      [...otherSameSuit].sort((a, b) => cardOrderValue(b, room) - cardOrderValue(a, room))
    );

    for (const comp of components) {
      const headValue = cardOrderValue(comp.cards[0], room);

      if (comp.kind === "tractor") {
        if (opponentHasBetterTractor(otherSameSuit, room, comp.unit, comp.count, headValue, ledSuit)) {
          allBlocked.push({
            cards: comp.cards,
            headValue,
            reason: `甩牌失败！${otherSeat.nickname} 手中有更大的拖拉机阻挡。`,
          });
        }
        continue;
      }

      // single / standalone pair / triple: beaten by a same-suit group of
      // equal-or-greater size whose top card is higher.
      const blocker = oGroups.find(
        (oGroup) => oGroup.length >= comp.unit && cardOrderValue(oGroup[0], room) > headValue
      );
      if (blocker) {
        allBlocked.push({
          cards: comp.cards,
          headValue,
          reason: `甩牌失败！${otherSeat.nickname} 手中有更大的${comp.unit >= 2 ? "牌型" : "单张"}阻挡。`,
        });
      }
    }
  }

  if (allBlocked.length === 0) return { ok: true, reason: "", blockedGroup: null };

  // Keep the smallest beaten component (lowest head card).
  allBlocked.sort((a, b) => a.headValue - b.headValue);
  return { ok: false, reason: allBlocked[0].reason, blockedGroup: allBlocked[0].cards };
}

// Find minimum cards to keep after failed throw:
// Returns the smallest blocked group (already computed by validateThrow).
function findThrowKeepCards(cards, blockedGroup, room) {
  if (blockedGroup && blockedGroup.length > 0) {
    return blockedGroup;
  }
  // Fallback: keep smallest single card
  const sorted = [...cards].sort((a, b) => cardOrderValue(a, room) - cardOrderValue(b, room));
  return [sorted[0]];
}

// 补充辅助函数：检查两手牌的牌型原子结构是否完全对齐（处理甩牌跟牌校验）
function isStructureMatch(cardsA, cardsB) {
  const gA = groupCards(cardsA).map(g => g.length).sort((x, y) => y - x);
  const gB = groupCards(cardsB).map(g => g.length).sort((x, y) => y - x);
  if (gA.length !== gB.length) return false;
  return gA.every((val, i) => val === gB[i]);
}

export function determineTrickWinner(room, plays) {
  let best = plays[0];
  for (const play of plays.slice(1)) {
    if (comparePlay(room, play, best, plays[0]) > 0) best = play;
  }
  return best.seat;
}

export function upgradeResult(attackers) {
  if (attackers <= 45) return { side: "dealer", steps: 3, label: "庄家队升 3 级" };
  if (attackers < 80) return { side: "dealer", steps: 2, label: "庄家队升 2 级" };
  if (attackers < 120) return { side: "dealer", steps: 1, label: "庄家队升 1 级" };
  if (attackers <= 160) return { side: "none", steps: 0, label: "不升不降" };
  if (attackers <= 200) return { side: "attackers", steps: 1, label: "闲家队升 1 级" };
  if (attackers < 240) return { side: "attackers", steps: 2, label: "闲家队升 2 级" };
  return { side: "attackers", steps: 3, label: "闲家队升 3 级" };
}

export function upgradeResultSix(attackers) {
  if (attackers <= 45) return { side: "dealer", steps: 3, label: "庄家队升 3 级" };
  if (attackers < 80) return { side: "dealer", steps: 2, label: "庄家队升 2 级" };
  if (attackers < 120) return { side: "dealer", steps: 1, label: "庄家队升 1 级" };
  if (attackers <= 160) return { side: "attackers", steps: 0, label: "闲家队上台，不升级" };
  if (attackers <= 200) return { side: "attackers", steps: 1, label: "闲家队上台，升 1 级" };
  if (attackers < 240) return { side: "attackers", steps: 2, label: "闲家队上台，升 2 级" };
  return { side: "attackers", steps: 3, label: "闲家队上台，升 3 级" };
}

// 【彻底修复 2】：完善墩牌大小裁判，防止垫牌、不匹配牌型盗取胜利
function comparePlay(room, challenger, currentBest, leadPlay) {
  const leadPlayCards = leadPlay.cards;
  const leadShape = analyzeShape(leadPlayCards, room);
  const ledSuit = playSuit(leadPlayCards[0], room);

  const challengerCards = challenger.cards;
  const challengerShape = analyzeShape(challengerCards, room);
  const challengerSuit = playSuit(challengerCards[0], room);

  const bestCards = currentBest.cards;
  const bestShape = analyzeShape(bestCards, room);
  const bestSuit = playSuit(bestCards[0], room);

  // 1. 张数不同，直接没有可比性
  if (challengerCards.length !== leadPlayCards.length) return -1;

  // 2. 判定挑战者是否属于“牌型与花色完全匹配”的合法压牌
  let challengerValid = false;
  let challengerIsTrumpCut = false;

  // 挑战者的组合结构必须和首出完全一致（例如：首出是两对，挑战者也必须出两对）
  // 注意：甩牌(throw)单独在下方分支处理，这里只处理单张/对子/三条/拖拉机。
  if (leadShape.type !== "throw" && challengerShape.type === leadShape.type && challengerShape.unit === leadShape.unit) {
    if (challengerSuit === ledSuit) {
      challengerValid = true; // 同花色同牌型正常跟牌
    } else if (ledSuit !== "trump" && challengerSuit === "trump" && isAllTrumpCards(challengerCards, room)) {
      challengerValid = true;
      challengerIsTrumpCut = true; // 主牌杀副牌
    }
  }

  // 特殊处理首出是"甩牌(throw)"的情况
  if (leadShape.type === "throw") {
    // 必须【整手】都是首出花色，才有资格按同花色比大小。
    // 只要混入别的花色（哪怕含主牌但不是全主牌），都只能算垫牌，压不过甩牌。
    const challengerAllLedSuit = challengerCards.every((c) => playSuit(c, room) === ledSuit);
    if (challengerAllLedSuit) {
      challengerValid = true;
    } else if (ledSuit !== "trump" && isAllTrumpCards(challengerCards, room)) {
      // 主牌杀：必须【整手】都是主牌，且结构与甩牌完全一致
      // (same count of tractors/triples/pairs/singles as the leader's throw)
      if (throwStructureMatch(challengerCards, leadPlayCards, room)) {
        challengerValid = true;
        challengerIsTrumpCut = true;
      }
    }
  }


  if (!challengerValid) return -1;

  // 3. 判定当前最优者是否是杀牌
  const bestIsTrumpCut = (leadShape.type === "throw")
    ? (ledSuit !== "trump" && isAllTrumpCards(bestCards, room))
    : (ledSuit !== "trump" && bestSuit === "trump" && isAllTrumpCards(bestCards, room));

  // 4. 开始比大小
  if (challengerIsTrumpCut) {
    if (!bestIsTrumpCut) return 1;
    if (leadShape.type === "throw") return compareByHighestTier(challengerCards, bestCards, room, leadPlayCards);
    return getShapeComparativeValue(challengerCards, room) - getShapeComparativeValue(bestCards, room);
  }

  if (bestIsTrumpCut) return -1;

  if (leadShape.type === "throw") return compareByHighestTier(challengerCards, bestCards, room, leadPlayCards);

  return getShapeComparativeValue(challengerCards, room) - getShapeComparativeValue(bestCards, room);
}

// For throw tricks: first identify the leader's highest component tier, then
// compare only that tier. If the leader threw only singles (e.g. A+K), a later
// pair is just two single cards; the pair tier must not outrank the leader.
function compareByHighestTier(challengerCards, bestCards, room, leaderCards) {
  const leaderInfo = highestThrowTier(leaderCards, room);
  const c = matchingThrowTierValue(challengerCards, room, leaderInfo);
  const b = matchingThrowTierValue(bestCards, room, leaderInfo);
  if (c.value !== b.value) return c.value - b.value;
  return -1; // same tier and value → earlier play wins
}

function highestThrowTier(cards, room) {
  const ledSuit = playSuit(cards[0], room);
  const components = decomposeThrowComponents(cards, room, ledSuit);
  let best = { tier: 1, unit: 1, count: 1, value: 0 };
  for (const comp of components) {
    const headValue = cardOrderValue(comp.cards[0], room);
    const tier = comp.kind === "tractor" ? 4 : comp.unit === 3 ? 3 : comp.unit === 2 ? 2 : 1;
    if (
      tier > best.tier ||
      (tier === best.tier && (headValue > best.value || (comp.count || 1) > best.count))
    ) {
      best = { tier, unit: comp.unit, count: comp.count || 1, value: headValue };
    }
  }
  return best;
}

function matchingThrowTierValue(cards, room, target) {
  if (target.tier === 1) {
    return { value: Math.max(...cards.map((card) => cardOrderValue(card, room))) };
  }
  const ledSuit = playSuit(cards[0], room);
  const components = decomposeThrowComponents(cards, room, ledSuit);
  let value = -Infinity;
  for (const comp of components) {
    if (target.tier === 4) {
      if (comp.kind === "tractor" && comp.unit === target.unit && comp.count >= target.count) {
        value = Math.max(value, cardOrderValue(comp.cards[0], room));
      }
    } else if (comp.kind === "group" && comp.unit === target.unit) {
      value = Math.max(value, cardOrderValue(comp.cards[0], room));
    }
  }
  return { value };
}



// 辅助函数：判断一组牌是否全为主牌
function isAllTrumpCards(cards, room) {
  return cards.every(card => playSuit(card, room) === "trump");
}

// Check if trump cut cards match the structural composition of the leader's throw.
// e.g. leader throws AAA+QQ+J (triple+pair+single) → trump cut must also be triple+pair+single.
function throwStructureMatch(trumpCards, leaderCards, room) {
  const getStructure = (cards) => {
    const sorted = [...cards].sort((a, b) => cardOrderValue(b, room) - cardOrderValue(a, room));
    const groups = groupCards(sorted);
    const counts = { tractor: 0, triple: 0, pair: 0, single: 0 };
    // detect tractors first
    const pairGroups = groups.filter(g => g.length >= 2);
    let usedAsTractor = new Set();
    for (let i = 0; i < pairGroups.length - 1; i++) {
      // 必须相邻两组张数相等才构成拖拉机（对连对、三连三）；否则“三条+相邻对子”
      // 会被误熔成拖拉机，导致合法主牌杀被错判无效。与 decomposeThrowComponents 对齐。
      if (pairGroups[i].length === pairGroups[i+1].length &&
          isConsecutiveInRules(pairGroups[i][0], pairGroups[i+1][0], playSuit(pairGroups[i][0], room), room)) {
        counts.tractor++;
        usedAsTractor.add(i);
        usedAsTractor.add(i+1);
        i++; // skip next
      }
    }
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const inTractor = pairGroups.indexOf(g) !== -1 && usedAsTractor.has(pairGroups.indexOf(g));
      if (inTractor) continue;
      if (g.length >= 3) counts.triple++;
      else if (g.length === 2) counts.pair++;
      else counts.single++;
    }
    return counts;
  };
  const ls = getStructure(leaderCards);
  const ts = getStructure(trumpCards);
  return ls.tractor === ts.tractor && ls.triple === ts.triple &&
         ls.pair === ts.pair && ls.single === ts.single;
}


// 辅助函数：获取牌型的真正用于比较的核心权重（解决只比最大单张的 Bug）
// 比如对子比对子的大小，拖拉机比拖拉机车头的大小
function getShapeComparativeValue(cards, room) {
  if (cards.length === 0) return 0;
  // 先按卡牌单张权力从大到小排序
  const sorted = [...cards].sort((a, b) => cardOrderValue(b, room) - cardOrderValue(a, room));
  
  // 对于升级/找朋友来说，不管是拖拉机还是对子、三条，排序后最顶端的那张牌（车头）就代表了整组牌的大小
  // 因为前面已经严格校验过 shape.type 必须一致，所以直接对比最强单张的权重是完全安全且符合规则的
  return cardOrderValue(sorted[0], room);
}

// 保留原有的单张权力值计算（无需修改，供上面调用）
export function cardOrderValue(card, room) {
  if (card.rank === "bigJoker") return 1000;
  if (card.rank === "smallJoker") return 990;
  const isLevel = card.rank === room.levelRank;
  if (isLevel && !room.noTrump && card.suit === room.trumpSuit) return 980;
  if (isLevel) return 970;
  if (!room.noTrump && card.suit === room.trumpSuit) return 500 + rankNumber(card.rank);
  return rankNumber(card.rank);
}

function playSuit(card, room) {
  if (card.rank === "bigJoker" || card.rank === "smallJoker") return "trump";
  if (card.rank === room.levelRank) return "trump";
  if (!room.noTrump && card.suit === room.trumpSuit) return "trump";
  return card.suit;
}

// 检测一手牌里是否“把某副已锁定的三条拆成了对子”：即出现一个恰好两张、
// 且其点数花色属于该座位锁定集合的组。返回锁定键 "rank|suit"，否则 null。
function lockedPairViolation(seat, cards, room) {
  if (!seat.lockedTriples || seat.lockedTriples.length === 0) return null;
  const sorted = [...cards].sort((a, b) => cardOrderValue(b, room) - cardOrderValue(a, room));
  for (const g of groupCards(sorted)) {
    if (g.length === 2) {
      const key = `${g[0].rank}|${g[0].suit}`;
      if (seat.lockedTriples.includes(key)) return key;
    }
  }
  return null;
}

// 在“跟对子”的选择时刻记录玩家是否保留了三条：
// 当首家出对子、跟家该门没有天然对子但有三条时，玩家可以选择不拆三条。
// 若他这一手没有把某副三条拆成对子（出的牌里该三条点数花色不足 2 张），
// 则把这副三条锁定，本局之后不得再拆成对子出。每位玩家分别记录。
function recordTripleLockDecision(room, seat, cards, leaderCards) {
  const leaderShape = analyzeShape(leaderCards, room);
  if (leaderShape.type !== "pair") return;
  const ledSuit = playSuit(leaderCards[0], room);
  const available = seat.hand.filter((c) => playSuit(c, room) === ledSuit); // 出牌前的手牌
  const groups = groupCards([...available].sort((a, b) => cardOrderValue(b, room) - cardOrderValue(a, room)));
  if (groups.some((g) => g.length === 2)) return; // 有天然对子 → 被强制跟对子，不存在“选择”
  const triples = groups.filter((g) => g.length >= 3);
  if (triples.length === 0) return;
  if (!seat.lockedTriples) seat.lockedTriples = [];
  for (const t of triples) {
    const key = `${t[0].rank}|${t[0].suit}`;
    if (seat.lockedTriples.includes(key)) continue;
    const playedOfKey = cards.filter((c) => c.rank === t[0].rank && c.suit === t[0].suit).length;
    if (playedOfKey !== 2) seat.lockedTriples.push(key); // 没拆成对子 → 锁定
  }
}

function forcedRequirement(leaderShape, available, room, lockedTriples = []) {
  // 被锁定的三条不能再拆成对子出，因此在计算“必须跟对”的强制要求时，
  // 锁定组不计入可用对子——否则会与锁定规则互相矛盾，造成无牌可出的死锁
  // （例如锁定三条只剩两张、又恰好是该门唯一的天然对子时）。
  const lockedSet = new Set(lockedTriples);
  const isLockedGroup = (g) => lockedSet.has(`${g[0].rank}|${g[0].suit}`);

  if (leaderShape.type === "tractor") {
    if (leaderShape.unit === 3) {
      const total = leaderShape.count * leaderShape.unit;
      const tripleRun = findBestTractorRun(available, room, 3);
      if (tripleRun && tripleRun.length >= leaderShape.count) return { type: "tractor", unit: 3, count: leaderShape.count };

      const groups = groupCards(available);
      const tripleCount = Math.min(leaderShape.count, groups.filter((g) => g.length >= 3).length);
      if (tripleCount > 0) {
        const remaining = total - tripleCount * 3;
        const pairAvail = groups.filter((g) => g.length >= 2 && g.length < 3 && !isLockedGroup(g)).length;
        return { type: "tripleFallback", triples: tripleCount, pairs: Math.min(Math.floor(remaining / 2), pairAvail) };
      }

      const pairSlots = Math.floor(total / 2);
      const pairPool = available.filter((c) => !lockedSet.has(`${c.rank}|${c.suit}`));
      const pairRun = findBestTractorRun(pairPool, room, 2);
      const pairAvail = groupCards(pairPool).filter((g) => g.length >= 2).length;
      if (pairRun && pairRun.length >= 2) {
        const tractorPairs = Math.min(pairRun.length, pairSlots);
        return { type: "pairTractorFallback", tractorPairs, pairs: Math.min(pairSlots, pairAvail) };
      }
      if (pairAvail > 0) return { type: "pairs", unit: 2, count: Math.min(pairSlots, pairAvail) };
      return { type: "any" };
    }

    // 对子拖拉机里锁定点数恰好用 2 张（= 拆对，违规），故检测可跟的拖拉机时
    // 把锁定牌整体剔除；三张单位的拖拉机用整组三张，不触发拆对，无需剔除。
    const tractorPool = leaderShape.unit === 2
      ? available.filter((c) => !lockedSet.has(`${c.rank}|${c.suit}`))
      : available;
    const tractors = findTractors(tractorPool, room, leaderShape.count * leaderShape.unit);
    if (tractors.length) return { type: "tractor", unit: leaderShape.unit, count: leaderShape.count };
    const pairsAvail = groupCards(available).filter((g) => g.length >= leaderShape.unit && !isLockedGroup(g));
    const pairCount = Math.min(leaderShape.count, pairsAvail.length);
    if (pairCount > 0) return { type: "pairs", unit: leaderShape.unit, count: pairCount };
    return { type: "any" };
  }

  if (leaderShape.type === "triple") {
    const tripleGroups = groupCards(available).filter((g) => g.length >= 3);
    if (tripleGroups.length >= 1) return { type: "triple", count: 1 };
    const pairGroups = groupCards(available).filter((g) => g.length >= 2 && !isLockedGroup(g));
    if (pairGroups.length >= 1) return { type: "pair", count: 1 };
    return { type: "any" };
  }

  if (leaderShape.type === "pair") {
    // 只有存在“天然对子”（恰好成对）时才强制跟对子；
    // 若只有三条而无对子，可选择不拆三张（规则允许）。
    const hasNaturalPair = groupCards(available).some((g) => g.length === 2 && !isLockedGroup(g));
    if (hasNaturalPair) return { type: "pair", count: 1 };
    return { type: "any" };
  }

  // Throw: decompose into atomic groups and compute per-group requirements
  // Returns a special "throw" requirement with breakdown
  if (leaderShape.type === "throw") {
    return { type: "any" }; // throw followers validated separately in validatePlay
  }

  return { type: "any" };
}

function shapeSatisfies(actual, wanted, cards, available, room) {
  if (wanted.type === "any") return true;

  // Sort before grouping so detection never depends on the order cards were picked.
  const sorted = [...cards].sort((a, b) => cardOrderValue(b, room) - cardOrderValue(a, room));

  if (wanted.type === "tractor") {
    return actual.type === "tractor" && actual.unit === wanted.unit && actual.count >= wanted.count;
  }

  if (wanted.type === "pairs") {
    // Must contain at least `wanted.count` pairs/triples of the correct unit size
    const groups = groupCards(sorted).filter((g) => g.length >= wanted.unit);
    return groups.length >= wanted.count;
  }

  if (wanted.type === "tripleFallback") {
    const groups = groupCards(sorted);
    const triples = groups.filter((g) => g.length >= 3).length;
    const pairs = groups.filter((g) => g.length >= 2 && g.length < 3).length;
    return triples >= wanted.triples && pairs >= wanted.pairs;
  }

  if (wanted.type === "pairTractorFallback") {
    const run = findBestTractorRun(cards, room, 2);
    const pairs = groupCards(sorted).filter((g) => g.length >= 2).length;
    return !!run && run.length >= wanted.tractorPairs && pairs >= wanted.pairs;
  }

  if (wanted.type === "triple") {
    // Must contain at least one group of 3
    return groupCards(sorted).some((g) => g.length >= 3);
  }

  if (wanted.type === "pair") {
    // Must contain at least one group of 2
    return groupCards(sorted).some((g) => g.length >= 2);
  }

  return true;
}

// 辅助函数：将相同点数和花色的牌归类到一个组中
function groupCards(sortedCards) {
  const groups = [];
  let currentGroup = [];
  
  for (const card of sortedCards) {
    if (currentGroup.length === 0) {
      currentGroup.push(card);
    } else {
      const prev = currentGroup[0];
      // 只有花色和点数完全一致的牌，才算进同一个对子或三条组（三副牌规则）
      if (card.rank === prev.rank && card.suit === prev.suit) {
        currentGroup.push(card);
      } else {
        groups.push(currentGroup);
        currentGroup = [card];
      }
    }
  }
  if (currentGroup.length > 0) groups.push(currentGroup);
  return groups;
}

function tractorUnitSize(groups) {
  if (groups.length < 2) return 0;
  if (groups.every((group) => group.length >= 3)) return 3;
  if (groups.every((group) => group.length >= 2)) return 2;
  return 0;
}

// 修复：考虑当前级牌（levelRank）被抽离后的动态连续性判定
function isConsecutiveGroups(groups, room) {
  if (groups.length < 2) return false;

  // 1. 获取当前主牌/副牌的动态牌序数组
  // 升级规则中，除去大王、小王、主级牌、副级牌后，剩下的数字是按顺序连续的
  const ledSuit = playSuit(groups[0][0], room);
  
  // 建立一个剔除了当前级牌的纯净大小顺序表
  // 比如打 10，这里就是 ['A', 'K', 'Q', 'J', '9', '8', '7', '6', '5', '4', '3', '2']
  const cleanRanks = RANKS.filter(r => r !== room.levelRank);

  // 2. 将出牌组合映射到这个纯净顺序表的索引中
  const indices = groups.map(group => {
    const card = group[0];
    
    // 如果是王牌或者级牌，它们在拖拉机里的连续性有特殊规则（通常大小王、主级牌、副级牌可以连）
    // 这里先处理普通花色和主牌普通数字的连续性
    if (card.rank === "bigJoker" || card.rank === "smallJoker" || card.rank === room.levelRank) {
      // 特殊高阶拖拉机判定（如大王+小王，或者主级牌+副级牌），这里赋予它们特定的虚拟连续索引
      if (card.rank === "bigJoker") return 100;
      if (card.rank === "smallJoker") return 99;
      // 级牌在主牌拖拉机中比较特殊，通常作为单独的档位
      return 98; 
    }
    
    return cleanRanks.indexOf(card.rank);
  }).sort((a, b) => a - b);

  // 3. 检查索引是否完全连续 (在 cleanRanks 中邻近)
  for (let i = 1; i < indices.length; i++) {
    // 如果包含任何无法识别的牌，或者索引不连续，则不是拖拉机
    if (indices[i] === -1 || indices[i - 1] === -1) return false;
    if (indices[i] - indices[i - 1] !== 1) {
      // 特殊兼容：处理主牌中大小王与级牌、级牌与A之间的特殊连法
      // 如果属于正常普通牌，差值不为 1 则直接失败
      if (indices[i] < 90) return false;
    }
  }
  return true;
}

// Find the best (longest) real tractor among `cards` whose total length ≥ `length`.
// Crucially this uses the SAME consecutiveness rule as analyzeShape
// (isConsecutiveInRules), so forcedRequirement and shapeSatisfies always agree.
// Previously a separate, looser check (isConsecutiveGroups) treated level/joker
// trump pairs as "consecutive" and could force a follower to play a tractor that
// analyzeShape didn't recognize — leaving them with no legal play.
function findTractors(cards, room, length) {
  const sorted = [...cards].sort((a, b) => cardOrderValue(b, room) - cardOrderValue(a, room));
  const groups = groupCards(sorted).filter((group) => group.length >= 2);
  if (groups.length < 2) return [];
  const ledSuit = playSuit(groups[0][0], room);
  let best = null;
  let i = 0;
  while (i < groups.length) {
    let j = i;
    const run = [groups[i]];
    while (
      j + 1 < groups.length &&
      groups[j + 1].length === groups[i].length &&
      isConsecutiveInRules(groups[j][0], groups[j + 1][0], ledSuit, room)
    ) {
      run.push(groups[j + 1]);
      j++;
    }
    if (run.length >= 2) {
      const total = run.reduce((sum, g) => sum + g.length, 0);
      if (total >= length && (!best || total > best.total)) best = { run, total };
    }
    i = j + 1;
  }
  return best ? [best.run] : [];
}

function findBestTractorRun(cards, room, unit = 2) {
  const sorted = [...cards].sort((a, b) => cardOrderValue(b, room) - cardOrderValue(a, room));
  const groups = groupCards(sorted).filter((group) => group.length >= unit);
  if (groups.length < 2) return null;
  let best = null;
  let i = 0;
  while (i < groups.length) {
    let j = i;
    const run = [groups[i]];
    const ledSuit = playSuit(groups[i][0], room);
    while (
      j + 1 < groups.length &&
      groups[j + 1].length >= unit &&
      playSuit(groups[j + 1][0], room) === ledSuit &&
      isConsecutiveInRules(groups[j][0], groups[j + 1][0], ledSuit, room)
    ) {
      run.push(groups[j + 1]);
      j++;
    }
    if (run.length >= 2 && (!best || run.length > best.length)) best = run;
    i = j + 1;
  }
  return best;
}

function hasGroup(cards, size) {
  return groupCards(cards).some((group) => group.length >= size);
}

function isAiSeat(room, seatIndex) {
  return room.seats[seatIndex]?.isAi === true;
}

// A seat acts automatically if it's an AI bot OR a human who turned on 托管.
function isAutoSeat(room, seatIndex) {
  const s = room.seats[seatIndex];
  return !!s && (s.isAi === true || s.trustee === true);
}

function chooseAiBury(room, dealer) {
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
  // Prefer recruiting a partner in the dealer's SHORTEST side suit (the dealer's
  // weak spot, so the friend complements it).
  const suitLen = {};
  for (const c of dealer.hand) if (!isTrump(c)) suitLen[c.suit] = (suitLen[c.suit] || 0) + 1;
  const RANK_PREF = ["A", "K", "10", "Q", "J", "9", "8", "7", "6", "5"];
  let best = null;
  for (const rank of RANK_PREF) {
    if (rank === level) continue; // level rank is trump — we want a side partner card
    for (const suit of SUITS) {
      const held = dealer.hand.filter((c) => c.rank === rank && c.suit === suit).length;
      const ordinal = held + 1;
      if (ordinal > 3) continue; // dealer holds all 3 copies — nobody else can have it
      const pts = (rank === "K" || rank === "10" || rank === "5") ? 1 : 0;
      const score = (held === 0 ? 60 : 0) + rankNumber(rank) + pts * 5 - (suitLen[suit] || 0) * 3 - held * 10;
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
  // 6 人轮庄：庄家必须定主，从所有花色里选最强的（不要求手里有级牌）。
  if (room.fixedTeams) {
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
  const hand = seat.hand;
  const level = room.dealerSeat === null ? seat.level : room.levelRank;
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
  const worthy = eagerFirstDealer || best.strength >= 2 || ratio >= profile.bidRatio;
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

function dealerTeamSeats(room) {
  if (room.fixedTeams) {
    // 6 人隔座固定队：与庄家同奇偶的座位是一队（{0,2,4} 或 {1,3,5}）。
    const parity = room.dealerSeat % 2;
    return room.seats.map((s) => s.index).filter((i) => i % 2 === parity);
  }
  return room.friendSeat === null || room.friendSeat === room.dealerSeat ? [room.dealerSeat] : [room.dealerSeat, room.friendSeat];
}

function attackerSeats(room) {
  const dealerTeam = new Set(dealerTeamSeats(room));
  return room.seats.map((seat) => seat.index).filter((index) => !dealerTeam.has(index));
}

function isDealerTeam(room, seatIndex) {
  return dealerTeamSeats(room).includes(seatIndex);
}

function buryMultiplier(shape) {
  if (!shape) return 2;
  // 规则：扣底倍率 = 2^(本墩获胜牌的张数)。单张2、对子4、三条8、四张拖拉机16…
  if (shape.type === "pair") return 4;
  if (shape.type === "triple") return 8;
  if (shape.type === "tractor") return 2 ** (shape.unit * shape.count);
  return 2;
}

function trumpKillSeats(room, plays = room.currentTrick) {
  if (!plays || plays.length < 2) return [];
  const leadPlay = plays[0];
  const ledSuit = playSuit(leadPlay.cards[0], room);
  if (ledSuit === "trump") return [];

  const seats = [];
  for (let i = 1; i < plays.length; i += 1) {
    const play = plays[i];
    if (!play.cards.every((card) => playSuit(card, room) === "trump")) continue;
    if (comparePlay(room, play, leadPlay, leadPlay) > 0) seats.push(play.seat);
  }
  return seats;
}

function forceCount(card) {
  if (card.rank === "A") return 1;
  if (card.rank === "J") return 11;
  if (card.rank === "Q") return 12;
  if (card.rank === "K") return 13;
  if (card.rank === "smallJoker") return 14;
  if (card.rank === "bigJoker") return 15;
  return Number(card.rank);
}

function nextSeat(index, seatCount) {
  return (index + 1) % seatCount;
}

// 【完美重构】：真正动态红黑交替的手牌理牌算法
export function sortHand(hand, room, overrideLevel = null) {
  const currentLevel = overrideLevel || room.levelRank || room.firstLevel;
  // Temporarily set levelRank so playSuit/cardOrderValue use the right rank
  const savedLevelRank = room.levelRank;
  if (overrideLevel) room.levelRank = overrideLevel;

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
  if (overrideLevel) room.levelRank = savedLevelRank;
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

export function publicState(room, viewerId = null) {
  const viewerSeat = findSeatByPlayer(room, viewerId);
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
    friendCall: room.friendCall,
    friendSeat: room.friendSeat,
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
      plays: t.plays.map((p) => ({ seat: p.seat, cards: p.cards.map((c) => ({ rank: c.rank, suit: c.suit, label: c.label })) }))
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
      isYou: seat.playerId === viewerId,
      hand: seat.playerId === viewerId ? seat.hand : []
    })),
    hiddenKittyCount: room.hiddenKitty.length,
    kittyCount: room.kitty.length,
    viewerSeat: viewerSeat?.index ?? null,
    isHost: room.hostId === viewerId,
    spectators: [...room.spectators.values()]
      .filter((s) => s.connected)
      .map((s) => s.nickname || "游客")
  };
}

export const constants = { PHASES, DEFAULT_SEATS };
