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

export function analyzeShape(cards, room) {
  const sorted = [...cards].sort((a, b) => cardOrderValue(a, room) - cardOrderValue(b, room));
  const groups = groupCards(sorted);
  if (cards.length === 1) return { type: "single", length: 1 };
  if (cards.length === 2 && groups.length === 1) return { type: "pair", length: 2, unit: 2 };
  if (cards.length === 3 && groups.length === 1) return { type: "triple", length: 3, unit: 3 };
  const tractorUnit = tractorUnitSize(groups);
  if (tractorUnit && cards.length >= 4 && isConsecutiveGroups(groups, room)) {
    return { type: "tractor", length: cards.length, unit: tractorUnit, groups: groups.length };
  }
  return { type: "throw", length: cards.length };
}

export function validatePlay(room, seat, cards, leaderCards) {
  if (!leaderCards) return { ok: true };
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

function comparePlay(room, challenger, currentBest, leadPlay) {
  const leadSuit = playSuit(leadPlay.cards[0], room);
  const challengerSuit = playSuit(challenger.cards[0], room);
  const bestSuit = playSuit(currentBest.cards[0], room);
  const challengerTrump = challengerSuit === "trump";
  const bestTrump = bestSuit === "trump";
  if (challengerTrump && !bestTrump) return 1;
  if (!challengerTrump && bestTrump) return -1;
  if (challengerSuit !== bestSuit && challengerSuit !== leadSuit) return -1;
  if (challenger.cards.length !== currentBest.cards.length) return -1;
  return maxCardValue(challenger.cards, room) - maxCardValue(currentBest.cards, room);
}

function maxCardValue(cards, room) {
  return Math.max(...cards.map((card) => cardOrderValue(card, room)));
}

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

function groupCards(cards) {
  const map = new Map();
  for (const card of cards) {
    const key = `${card.rank}:${card.suit}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(card);
  }
  return [...map.values()].sort((a, b) => b.length - a.length || a[0].label.localeCompare(b[0].label));
}

function tractorUnitSize(groups) {
  if (groups.length < 2) return 0;
  if (groups.every((group) => group.length >= 3)) return 3;
  if (groups.every((group) => group.length >= 2)) return 2;
  return 0;
}

function isConsecutiveGroups(groups, room) {
  const values = groups.map((group) => cardOrderValue(group[0], room)).sort((a, b) => a - b);
  for (let i = 1; i < values.length; i += 1) {
    if (values[i] - values[i - 1] !== 1 && values[i] - values[i - 1] !== 10) return false;
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

function sortHand(hand, room) {
  hand.sort((a, b) => handSortValue(a, room) - handSortValue(b, room) || a.copy - b.copy);
}

function handSortValue(card, room) {
  const levelRank = room.levelRank;
  if (card.rank === "bigJoker") return 0;
  if (card.rank === "smallJoker") return 10;
  if (levelRank && !room.noTrump && card.suit === room.trumpSuit && card.rank === levelRank) return 20;
  if (levelRank && card.rank === levelRank) return 30 + suitSortIndex(card.suit, room);
  if (!room.noTrump && card.suit === room.trumpSuit) return 100 + rankSortIndex(card.rank);
  return 300 + suitSortIndex(card.suit, room) * 20 + rankSortIndex(card.rank);
}

function rankSortIndex(rank) {
  return RANKS.indexOf(rank) >= 0 ? RANKS.indexOf(rank) : 99;
}

function suitSortIndex(suit, room) {
  const order = suitOrder(room.trumpSuit);
  const index = order.indexOf(suit);
  return index >= 0 ? index : 99;
}

function suitOrder(trumpSuit) {
  if (trumpSuit === "hearts") return ["hearts", "spades", "diamonds", "clubs"];
  if (trumpSuit === "diamonds") return ["diamonds", "spades", "hearts", "clubs"];
  if (trumpSuit === "spades") return ["spades", "hearts", "clubs", "diamonds"];
  if (trumpSuit === "clubs") return ["clubs", "hearts", "spades", "diamonds"];
  return ["spades", "hearts", "diamonds", "clubs"];
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
