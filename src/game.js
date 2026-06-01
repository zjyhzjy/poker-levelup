import crypto from "node:crypto";
import { cardScore, createDeck, levelAdvance, LEVEL_RANKS, rankNumber, RANKS, shuffle, SUITS } from "./cards.js";

const SEATS = 5;
const HAND_SIZE = 31;
const KITTY_SIZE = 7;
const PHASES = {
  LOBBY: "lobby",
  DEALING: "dealing",
  AUCTION_READY: "auctionReady",
  AUCTION: "auction",
  FORCED_SUIT: "forcedSuit",
  BURYING: "burying",
  FRIEND: "friend",
  PLAYING: "playing",
  ROUND_OVER: "roundOver"
};

function uid(prefix = "id") {
  return `${prefix}_${crypto.randomBytes(5).toString("hex")}`;
}

function emptySeats() {
  return Array.from({ length: SEATS }, (_, index) => ({
    index,
    playerId: null,
    nickname: "",
    level: null,
    hand: [],
    connected: false,
    isAi: false,
    takenTrickPoints: 0
  }));
}

export function createRoom(code = randomRoomCode()) {
  return {
    code,
    phase: PHASES.LOBBY,
    seats: emptySeats(),
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
    deck: [],
    kitty: [],
    revealedKitty: [],
    friendCall: null,
    friendSeat: null,
    hiddenKitty: [],
    currentLeader: null,
    turnSeat: null,
    currentTrick: [],
    finishedTricks: [],
    tableLog: [],
    scores: { attackers: 0, dealerTeam: 0 },
    lastResult: null
  };
}

export function randomRoomCode() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

export function joinRoom(room, playerId, nickname) {
  if (!room.hostId) room.hostId = playerId;
  room.spectators.set(playerId, { playerId, nickname: nickname?.trim() || "游客", connected: true });
  return publicState(room, playerId);
}

export function sit(room, playerId, seatIndex, nickname) {
  assertPhase(room, PHASES.LOBBY);
  const seat = room.seats[seatIndex];
  if (!seat) throw new Error("座位不存在");
  if (seat.playerId && seat.playerId !== playerId) throw new Error("这个座位已经有人了");
  for (const other of room.seats) {
    if (other.playerId === playerId) {
      other.playerId = null;
      other.nickname = "";
      other.connected = false;
    }
  }
  seat.playerId = playerId;
  seat.nickname = nickname?.trim() || room.spectators.get(playerId)?.nickname || `玩家${seatIndex + 1}`;
  seat.connected = true;
  seat.isAi = false;
  room.spectators.delete(playerId);
}

export function addAiPlayer(room, seatIndex) {
  assertPhase(room, PHASES.LOBBY);
  const seat = room.seats[seatIndex];
  if (!seat) throw new Error("座位不存在");
  if (seat.playerId) throw new Error("这个座位已经有人了");
  seat.playerId = uid("ai");
  seat.nickname = `AI ${seatIndex + 1}`;
  seat.connected = true;
  seat.isAi = true;
}

export function leaveSeat(room, playerId) {
  assertPhase(room, PHASES.LOBBY);
  const seat = findSeatByPlayer(room, playerId);
  if (!seat) return;
  room.spectators.set(playerId, { playerId, nickname: seat.nickname, connected: true });
  seat.playerId = null;
  seat.nickname = "";
  seat.connected = false;
  seat.isAi = false;
}

export function startRound(room, random = Math.random) {
  assertPhase(room, PHASES.LOBBY);
  if (room.seats.some((seat) => !seat.playerId)) throw new Error("需要 5 名玩家全部坐下");
  room.round += 1;
  const firstRound = room.round === 1;
  const level = firstRound ? LEVEL_RANKS[Math.floor(random() * LEVEL_RANKS.length)] : null;
  room.firstLevel = room.firstLevel ?? level;
  room.levelRank = null;
  room.trumpSuit = null;
  room.noTrump = false;
  room.dealerSeat = null;
  room.currentBid = null;
  room.revealedKitty = [];
  room.friendCall = null;
  room.friendSeat = null;
  room.hiddenKitty = [];
  room.currentTrick = [];
  room.finishedTricks = [];
  room.scores = { attackers: 0, dealerTeam: 0 };
  room.lastResult = null;
  room.tableLog = [];
  room.kitty = [];
  room.deck = shuffle(createDeck(), random);
  room.phase = PHASES.DEALING;
  room.starterSeat = firstRound ? Math.floor(random() * SEATS) : nextSeat(room.starterSeat);
  room.currentLeader = room.starterSeat;
  room.turnSeat = room.starterSeat;
  for (const seat of room.seats) {
    seat.hand = [];
    seat.takenTrickPoints = 0;
    if (firstRound) seat.level = room.firstLevel;
  }
  dealAll(room);
  
  room.tableLog.push(`本轮从 ${seatName(room, room.starterSeat)} 开始逆时针摸牌。`);
  // 在 startRound 函数发牌逻辑结束后加入：
  room.tableLog.push(`【系统】本局游戏开始！所有玩家的当前级牌为: ${room.levelRank}`);
  if (!room.currentBid) {
    room.phase = PHASES.AUCTION_READY;
    room.tableLog.push("摸牌结束无人亮主，等待手动开始翻底拍卖。");
  }
}

function dealAll(room) {
  let seatIndex = room.starterSeat;
  while (room.deck.length > KITTY_SIZE) {
    const card = room.deck.shift();
    room.seats[seatIndex].hand.push(card);
    seatIndex = nextSeat(seatIndex);
  }
  room.kitty = room.deck.splice(0);
  for (const seat of room.seats) sortHand(seat.hand, room);
}

export function makeBid(room, playerId, cardIds) {
  if (![PHASES.DEALING, PHASES.AUCTION_READY, PHASES.AUCTION].includes(room.phase)) throw new Error("现在不能抢庄");
  const seat = findSeatByPlayer(room, playerId);
  if (!seat) throw new Error("请先入座");
  const cards = pickCards(seat.hand, cardIds);
  const bid = evaluateBid(cards, seat.level);
  if (!bid) throw new Error("只能亮自己的常主牌，或任意 3 张王");
  if (room.currentBid && compareBid(bid, room.currentBid) <= 0) throw new Error("必须用更高强度抢庄");
  room.currentBid = { ...bid, seat: seat.index, playerId };
  room.dealerSeat = seat.index;
  room.levelRank = bid.levelRank;
  room.noTrump = bid.noTrump;
  room.trumpSuit = bid.trumpSuit;
  room.tableLog.push(`${seat.nickname} 抢庄：${cards.map((card) => card.label).join("、")}`);
  if (room.phase === PHASES.AUCTION) confirmDealer(room);
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
  if (room.revealedKitty.length === KITTY_SIZE) {
    forceDealer(room, card);
  }
}

export function confirmDealer(room) {
  if (!room.currentBid) throw new Error("还没有庄家");
  room.dealerSeat = room.currentBid.seat;
  room.levelRank = room.currentBid.levelRank;
  room.trumpSuit = room.currentBid.trumpSuit;
  room.noTrump = room.currentBid.noTrump;
  giveKittyToDealer(room);
}

export function forceDealer(room, lastKittyCard, chosenSuit = null) {
  const count = forceCount(lastKittyCard);
  let seatIndex = room.starterSeat;
  for (let i = 1; i < count; i += 1) seatIndex = nextSeat(seatIndex);
  const dealer = room.seats[seatIndex];
  room.dealerSeat = seatIndex;
  room.levelRank = dealer.level;
  room.noTrump = false;
  room.trumpSuit = chosenSuit && SUITS.includes(chosenSuit) ? chosenSuit : (lastKittyCard.suit === "joker" ? "spades" : lastKittyCard.suit);
  room.currentBid = { seat: seatIndex, playerId: dealer.playerId, strength: 0, levelRank: dealer.level, trumpSuit: room.trumpSuit, noTrump: false };
  room.phase = PHASES.FORCED_SUIT;
  room.tableLog.push(`${dealer.nickname} 被强制坐庄，可选择是否亮自己的常主花色改主。`);
  // 【修复】：强制坐庄确立主花色后，立刻触发出牌排序变更
  for (const seat of room.seats) {
    sortHand(seat.hand, room);
  }
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
    room.currentBid.noTrump = true;
    room.currentBid.trumpSuit = null;
    sortHand(dealer.hand, room);
    room.tableLog.push(`${dealer.nickname} 亮 3 张王，强制定为无主。`);
    giveKittyToDealer(room);
    return;
  }
  if (suit && !SUITS.includes(suit)) throw new Error("花色不存在");
  if (suit) room.trumpSuit = suit;
  room.currentBid.trumpSuit = room.trumpSuit;
  room.currentBid.noTrump = false;
  sortHand(dealer.hand, room);
  room.tableLog.push(`${dealer.nickname} 定主花色为 ${room.trumpSuit}`);
  giveKittyToDealer(room);
}

function giveKittyToDealer(room) {
  const dealer = room.seats[room.dealerSeat];
  dealer.hand.push(...room.kitty);
  sortHand(dealer.hand, room);
  room.phase = PHASES.BURYING;
  room.tableLog.push(`${dealer.nickname} 拿起底牌，请扣 7 张。`);
}

export function buryKitty(room, playerId, cardIds) {
  assertPhase(room, PHASES.BURYING);
  const dealer = findSeatByPlayer(room, playerId);
  if (!dealer || dealer.index !== room.dealerSeat) throw new Error("只有庄家可以扣底");
  if (cardIds.length !== KITTY_SIZE) throw new Error("必须扣 7 张");
  const cards = removeCards(dealer.hand, cardIds);
  room.hiddenKitty = cards;
  sortHand(dealer.hand, room);
  room.phase = PHASES.FRIEND;
  room.tableLog.push(`${dealer.nickname} 已扣底，等待叫朋友。`);
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
  room.tableLog.push(`${dealer.nickname} 叫朋友：第 ${ordinal} 张 ${calledCardLabel(room.friendCall)}`);
}

export function playCards(room, playerId, cardIds) {
  assertPhase(room, PHASES.PLAYING);
  const seat = findSeatByPlayer(room, playerId);
  if (!seat) throw new Error("请先入座");
  if (seat.index !== room.turnSeat) throw new Error("还没轮到你");
  const cards = pickCards(seat.hand, cardIds);
  if (!cards.length) throw new Error("请选择要出的牌");
  const leaderPlay = room.currentTrick[0]?.cards ?? null;
  const validation = validatePlay(room, seat, cards, leaderPlay);
  if (!validation.ok) throw new Error(validation.reason);
  removeCards(seat.hand, cardIds);
  const play = { seat: seat.index, cards, shape: analyzeShape(cards, room), points: cards.reduce((sum, card) => sum + cardScore(card), 0) };
  room.currentTrick.push(play);
  updateFriend(room, play);
  room.tableLog.push(`${seat.nickname} 出牌：${cards.map((card) => card.label).join("、")}`);
  if (room.currentTrick.length === SEATS) {
    finishTrick(room);
  } else {
    room.turnSeat = nextSeat(room.turnSeat);
  }
}

export function runAiStep(room) {
  if (room.phase === PHASES.AUCTION_READY) return false;
  if (room.phase === PHASES.AUCTION) {
    if (room.currentBid) confirmDealer(room);
    else revealKittyCard(room);
    return true;
  }
  if (room.phase === PHASES.FORCED_SUIT && isAiSeat(room, room.dealerSeat)) {
    chooseForcedTrump(room, room.seats[room.dealerSeat].playerId, null);
    return true;
  }
  if (room.phase === PHASES.BURYING && isAiSeat(room, room.dealerSeat)) {
    const dealer = room.seats[room.dealerSeat];
    const cards = chooseAiBury(dealer.hand, room).map((card) => card.id);
    buryKitty(room, dealer.playerId, cards);
    return true;
  }
  if (room.phase === PHASES.FRIEND && isAiSeat(room, room.dealerSeat)) {
    const dealer = room.seats[room.dealerSeat];
    const card = chooseAiFriendCard(dealer.hand);
    callFriend(room, dealer.playerId, { ordinal: 1, rank: card.rank, suit: card.suit });
    return true;
  }
  if (room.phase === PHASES.PLAYING && isAiSeat(room, room.turnSeat)) {
    const seat = room.seats[room.turnSeat];
    const leaderCards = room.currentTrick[0]?.cards ?? null;
    const cards = chooseAiPlay(room, seat, leaderCards);
    playCards(room, seat.playerId, cards.map((card) => card.id));
    return true;
  }
  return false;
}

export function chooseAiPlay(room, seat, leaderCards = null) {
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
  return seat.hand.slice(0, length);
}

function finishTrick(room) {
  const winner = determineTrickWinner(room, room.currentTrick);
  const points = room.currentTrick.reduce((sum, play) => sum + play.points, 0);
  room.seats[winner].takenTrickPoints += points;
  if (!isDealerTeam(room, winner)) room.scores.attackers += points;
  else room.scores.dealerTeam += points;
  room.finishedTricks.push({ plays: room.currentTrick, winner, points });
  room.tableLog.push(`${seatName(room, winner)} 赢得本墩，${points} 分。`);
  room.currentTrick = [];
  if (room.seats.every((seat) => seat.hand.length === 0)) {
    finishRound(room, winner);
    return;
  }
  room.currentLeader = winner;
  room.turnSeat = winner;
}

function finishRound(room, lastWinner) {
  const kittyPoints = room.hiddenKitty.reduce((sum, card) => sum + cardScore(card), 0);
  let buriedBonus = 0;
  if (!isDealerTeam(room, lastWinner)) {
    buriedBonus = kittyPoints * buryMultiplier(room.finishedTricks.at(-1)?.plays.find((play) => play.seat === lastWinner)?.shape);
    room.scores.attackers += buriedBonus;
  }
  const attackers = room.scores.attackers;
  const result = upgradeResult(attackers);
  const upgradedSeats = result.side === "dealer" ? dealerTeamSeats(room) : attackerSeats(room);
  for (const seatIndex of upgradedSeats) {
    const seat = room.seats[seatIndex];
    seat.level = levelAdvance(seat.level, result.steps);
  }
  room.lastResult = { attackers, buriedBonus, result, upgradedSeats };
  room.phase = PHASES.ROUND_OVER;
  room.tableLog.push(`本局结束，闲家 ${attackers} 分。${result.label}`);
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
  if (!leaderCards) {
    // 作为首出牌者，如果选择了甩牌 (Throw)
    const shape = analyzeShape(cards, room);
    if (shape.type === "throw") {
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
  if (following.length === cards.length) {
    const wanted = forcedRequirement(leaderShape, available, room);
    const actual = analyzeShape(cards, room);
    if (!shapeSatisfies(actual, wanted)) return { ok: false, reason: "需要优先跟同类牌型" };
  }
  return { ok: true };
}

// 【彻底修复 3】：精准拆解甩牌组合，防止非对应牌型发生阻挡误判
function validateThrow(room, throwerSeat, cards) {
  const ledSuit = playSuit(cards[0], room);
  const throwerSorted = [...cards].sort((a, b) => cardOrderValue(b, room) - cardOrderValue(a, room));
  const tGroups = groupCards(throwerSorted); // 拆解出的组合，如 [[A,A,A], [K,K]]

  // 遍历其他所有防守方玩家
  for (const otherSeat of room.seats) {
    if (otherSeat.index === throwerSeat.index) continue;

    const otherSameSuit = otherSeat.hand.filter(c => playSuit(c, room) === ledSuit);
    if (otherSameSuit.length === 0) continue;
    
    const oGroups = groupCards(otherSameSuit);

    // 对你甩牌里的每一个原子组合进行针对性大牌扫描
    for (const tGroup of tGroups) {
      const tLen = tGroup.length; // 该组合的张数（1代表单张，2代表对子，3代表三条）
      const tValue = cardOrderValue(tGroup[0], room);

      // 寻找防守方手里有没有【相同结构】且【牌面更大】的牌进行阻挡
      // 规则：能管住对子的只有更大的对子；能管住三条的只有更大的三条
      const blocker = oGroups.find(oGroup => oGroup.length >= tLen && cardOrderValue(oGroup[0], room) > tValue);

      if (blocker) {
        // 如果你甩的是拖拉机（连对），防守方必须也有对应大小的连对才能阻挡
        const tShape = analyzeShape(tGroup, room);
        if (tShape.type === "tractor") {
          // 扫描防守方手牌是否能凑出比你这个车头更大的拖拉机
          const betterTractors = findTractors(otherSameSuit, room, tGroup.length);
          if (betterTractors.length > 0 && cardOrderValue(betterTractors[0][0][0], room) > tValue) {
            return { ok: false, reason: `甩牌失败！${otherSeat.nickname} 手中有更大的拖拉机阻挡。` };
          }
          continue; // 如果别人没有更大拖拉机，单凭三条或普通大对子是挡不住你拖拉机的，继续检查下一个组合
        }

        // 普通单张、对子、三条的阻挡确立
        return { ok: false, reason: `甩牌失败！${otherSeat.nickname} 手中有更大的牌型阻挡。` };
      }
    }
  }
  return { ok: true };
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
  if (challengerShape.type === leadShape.type && challengerShape.unit === leadShape.unit) {
    if (challengerSuit === ledSuit) {
      challengerValid = true; // 同花色同牌型正常跟牌
    } else if (ledSuit !== "trump" && challengerSuit === "trump" && isAllTrumpCards(challengerCards, room)) {
      challengerValid = true;
      challengerIsTrumpCut = true; // 主牌杀副牌
    }
  }

  // 特殊处理首出是“甩牌(throw)”的情况
  if (leadShape.type === "throw") {
    // 甩牌情况下，跟牌者必须完全是同花色，或者全为主牌“毙”掉，且内部的具体结构（对子、单张数量）要完全对得上才有资格赢
    if (challengerSuit === ledSuit && isStructureMatch(challengerCards, leadPlayCards)) {
      challengerValid = true;
    } else if (ledSuit !== "trump" && challengerSuit === "trump" && isAllTrumpCards(challengerCards, room) && isStructureMatch(challengerCards, leadPlayCards)) {
      challengerValid = true;
      challengerIsTrumpCut = true;
    }
  }

  // 如果挑战者不合法（属于未能跟出对应牌型的垫牌），直接判定输
  if (!challengerValid) return -1;

  // 3. 判定当前最优者是否是杀牌
  let bestIsTrumpCut = (ledSuit !== "trump" && bestSuit === "trump" && isAllTrumpCards(bestCards, room));

  // 4. 开始比大小
  if (challengerIsTrumpCut) {
    if (!bestIsTrumpCut) return 1; // 挑战者是杀牌，之前没人杀，挑战者大
    return getShapeComparativeValue(challengerCards, room) - getShapeComparativeValue(bestCards, room);
  }

  if (bestIsTrumpCut) return -1; // 之前有人杀了，普通跟牌大不过杀牌

  return getShapeComparativeValue(challengerCards, room) - getShapeComparativeValue(bestCards, room);
}


// 辅助函数：判断一组牌是否全为主牌
function isAllTrumpCards(cards, room) {
  return cards.every(card => playSuit(card, room) === "trump");
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

function forcedRequirement(shape, available, room) {
  if (shape.type === "tractor") {
    const tractors = findTractors(available, room, shape.length);
    if (tractors.length) return { type: "tractor", length: shape.length };
    return { type: "pairs", count: Math.floor(shape.length / 2) };
  }
  if (shape.type === "triple") {
    if (hasGroup(available, 3)) return { type: "triple" };
    if (hasGroup(available, 2)) return { type: "pairPlus" };
  }
  if (shape.type === "pair" && hasGroup(available, 2)) return { type: "pair" };
  return { type: "any" };
}

function shapeSatisfies(shape, wanted) {
  if (wanted.type === "any") return true;
  if (wanted.type === "tractor") return shape.type === "tractor" && shape.length === wanted.length;
  if (wanted.type === "triple") return shape.type === "triple";
  if (wanted.type === "pair") return shape.type === "pair" || shape.type === "tractor" || shape.type === "triple";
  if (wanted.type === "pairPlus") return ["pair", "triple", "tractor", "throw"].includes(shape.type);
  if (wanted.type === "pairs") return shape.type === "tractor" || shape.type === "throw" || shape.type === "pair";
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

function findTractors(cards, room, length) {
  const groups = groupCards(cards).filter((group) => group.length >= 2);
  return isConsecutiveGroups(groups, room) && groups.reduce((sum, group) => sum + Math.min(group.length, 3), 0) >= length ? [groups] : [];
}

function hasGroup(cards, size) {
  return groupCards(cards).some((group) => group.length >= size);
}

function isAiSeat(room, seatIndex) {
  return room.seats[seatIndex]?.isAi === true;
}

function chooseAiBury(hand, room) {
  return [...hand]
    .sort((a, b) => cardScore(a) - cardScore(b) || cardOrderValue(a, room) - cardOrderValue(b, room))
    .slice(0, KITTY_SIZE);
}

function chooseAiFriendCard(hand) {
  return hand.find((card) => card.rank !== "bigJoker" && card.rank !== "smallJoker") ?? hand[0];
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

function findAnyLegalCombination(room, seat, leaderCards, length) {
  const sorted = [...seat.hand].sort((a, b) => cardOrderValue(a, room) - cardOrderValue(b, room));
  const combo = [];
  let checked = 0;
  const limit = 12000;
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
        room.tableLog.push(`${seatName(room, play.seat)} 成为朋友。`);
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
  if (shape.type === "pair") return 4;
  if (shape.type === "triple") return 8;
  if (shape.type === "tractor") return 2 ** shape.length;
  return 2;
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

function nextSeat(index) {
  return (index + 1) % SEATS;
}

// 【完美重构】：真正动态红黑交替的手牌理牌算法
export function sortHand(hand, room) {
  const currentLevel = room.levelRank || room.firstLevel;

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
  
  // 交叉合并算法：只要红黑都有，就交替插入，彻底封杀“红红”相邻
  while (blackSuits.length > 0 || redSuits.length > 0) {
    if (blackSuits.length > 0) {
      sideCardsSorted.push(...blackSuits.shift());
    }
    if (redSuits.length > 0) {
      sideCardsSorted.push(...redSuits.shift());
    }
  }

  // 5. 最终合体：主牌在最左边，绝对动态红黑相间的副牌紧随其后
  const finalHand = [...trumpCards, ...sideCardsSorted];

  // 6. 把排好序的牌写回玩家手牌数组中
  hand.length = 0;
  for (const card of finalHand) {
    hand.push(card);
  }
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

export function publicState(room, viewerId = null) {
  const viewerSeat = room.seats.find(s => s.playerId === viewerId);
  return {
    code: room.code,
    phase: room.phase,
    round: room.round,
    starterSeat: room.starterSeat,
    levelRank: room.levelRank,
    trumpSuit: room.trumpSuit,
    noTrump: room.noTrump,
    dealerSeat: room.dealerSeat,
    currentBid: room.currentBid,
    revealedKitty: room.revealedKitty,
    friendCall: room.friendCall,
    friendSeat: room.friendSeat,
    currentLeader: room.currentLeader,
    turnSeat: room.turnSeat,
    currentTrick: room.currentTrick,
    scores: room.scores,
    lastResult: room.lastResult,
    tableLog: room.tableLog.slice(-40),
    seats: room.seats.map((seat) => ({
      index: seat.index,
      playerId: seat.playerId,
      nickname: seat.nickname,
      level: seat.level,
      connected: seat.connected,
      isAi: seat.isAi === true,
      handCount: seat.hand.length,
      takenTrickPoints: seat.takenTrickPoints,
      isYou: seat.playerId === viewerId,
      hand: seat.playerId === viewerId ? seat.hand : []
    }))
  };
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

function seatName(room, seatIndex) {
  return room.seats[seatIndex]?.nickname || `座位${seatIndex + 1}`;
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
    currentBid: room.currentBid,
    revealedKitty: room.revealedKitty,
    friendCall: room.friendCall,
    friendSeat: room.friendSeat,
    currentLeader: room.currentLeader,
    turnSeat: room.turnSeat,
    currentTrick: room.currentTrick,
    scores: room.scores,
    lastResult: room.lastResult,
    tableLog: room.tableLog.slice(-40),
    seats: room.seats.map((seat) => ({
      index: seat.index,
      playerId: seat.playerId,
      nickname: seat.nickname,
      level: seat.level,
      connected: seat.connected,
      isAi: seat.isAi === true,
      handCount: seat.hand.length,
      takenTrickPoints: seat.takenTrickPoints,
      isYou: seat.playerId === viewerId,
      hand: seat.playerId === viewerId ? seat.hand : []
    })),
    hiddenKittyCount: room.hiddenKitty.length,
    kittyCount: room.kitty.length,
    viewerSeat: viewerSeat?.index ?? null,
    isHost: room.hostId === viewerId
  };
}

export const constants = { PHASES, SEATS, HAND_SIZE, KITTY_SIZE };
