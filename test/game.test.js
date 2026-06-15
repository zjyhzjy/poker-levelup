import test from "node:test";
import assert from "node:assert/strict";
import { createDeck } from "../src/cards.js";
import { addAiPlayer, analyzeShape, buryKitty, dominantThrowShape, callSixTrump, chooseAiFriendCard, chooseAiPlay, chooseForcedTrump, confirmDealer, createRoom, crossesChampion, dealRound, decideAiBid, determineTrickWinner, evaluateBid, forceDealer, kickSeatByVote, makeBid, passBid, passSixTrump, playCards, publicState, recommendPlay, recomputeScores, revealKittyCard, runAiStep, setTrustee, sit, startAuction, startRound, takeoverAiSeat, upgradeResult, upgradeResultClassic4, upgradeResultSix, validatePlay } from "../src/game.js";
import { buryMultiplierClassic4 } from "../src/rules/classic4.js";

test("三副牌共 162 张", () => {
  assert.equal(createDeck().length, 162);
});

test("两副牌共 108 张", () => {
  assert.equal(createDeck(2).length, 108);
});

test("首轮发牌后 5 人各 31 张，底牌 7 张", () => {
  const room = createRoom("TEST");
  for (let i = 0; i < 5; i += 1) {
    room.seats[i].playerId = `p${i}`;
    room.seats[i].nickname = `玩家${i}`;
  }
  startRound(room, () => 0.1);
  assert.deepEqual(room.seats.map((seat) => seat.hand.length), [31, 31, 31, 31, 31]);
  assert.equal(room.kitty.length, 7);
});

test("抢庄强度识别", () => {
  const deck = createDeck();
  const one = deck.find((card) => card.rank === "2" && card.suit === "hearts");
  const pair = deck.filter((card) => card.rank === "2" && card.suit === "hearts").slice(0, 2);
  const jokers = deck.filter((card) => card.suit === "joker").slice(0, 3);
  assert.equal(evaluateBid([one], "2").strength, 1);
  assert.equal(evaluateBid(pair, "2").strength, 2);
  assert.equal(evaluateBid(jokers, "2").noTrump, true);
});

test("5 人抢庄前按本人等级理牌，亮庄后统一按庄家等级理牌", () => {
  const room = createRoom("LEVELSORT");
  const deck = createDeck();
  for (let i = 0; i < 5; i += 1) {
    const seat = room.seats[i];
    seat.playerId = `p${i}`;
    seat.nickname = `P${i}`;
    seat.level = i === 0 ? "4" : "A";
  }
  room.phase = "dealing";
  room.dealing = true;
  room.dealCursor = 0;
  room.levelRank = null;
  room.firstLevel = "A";
  room.kittySize = 0;
  const card = (rank, suit, copy = 1) => deck.find((c) => c.rank === rank && c.suit === suit && c.copy === copy);
  room.deck = [
    card("A", "spades", 1), card("2", "hearts", 1), card("3", "clubs", 1), card("5", "diamonds", 1), card("6", "spades", 1),
    card("4", "clubs", 1), card("7", "hearts", 1), card("8", "clubs", 1), card("9", "diamonds", 1), card("10", "spades", 1)
  ];
  dealRound(room);
  dealRound(room);
  assert.equal(room.seats[0].hand[0].rank, "4", "抢庄前本人打 4 时，自己的 4 应排进常主区");

  room.phase = "dealing";
  room.dealing = false;
  room.seats[0].hand.push(card("4", "hearts", 1));
  room.seats[1].hand = [card("A", "spades", 2), card("4", "clubs", 2)];
  makeBid(room, "p0", [card("4", "hearts", 1).id]);
  assert.equal(room.levelRank, "4");
  assert.equal(room.seats[1].hand[0].rank, "4", "亮庄后其他玩家也应按庄家打 4 理牌，不能继续把 A 当常主");
});

test("基础牌型识别", () => {
  const room = createRoom("TEST");
  room.levelRank = "2";
  room.trumpSuit = "hearts";
  const deck = createDeck();
  const triple = deck.filter((card) => card.rank === "A" && card.suit === "spades").slice(0, 3);
  const pair44 = deck.filter((card) => card.rank === "4" && card.suit === "clubs").slice(0, 2);
  const pair33 = deck.filter((card) => card.rank === "3" && card.suit === "clubs").slice(0, 2);
  assert.equal(analyzeShape(triple, room).type, "triple");
  assert.equal(analyzeShape([...pair44, ...pair33], room).type, "tractor");
});

test("升级分档", () => {
  assert.deepEqual(upgradeResult(45), { side: "dealer", steps: 3, label: "庄家队升 3 级" });
  assert.deepEqual(upgradeResult(120), { side: "none", steps: 0, label: "不升不降" });
  assert.deepEqual(upgradeResult(200), { side: "attackers", steps: 1, label: "闲家队升 1 级" });
  assert.deepEqual(upgradeResult(240), { side: "attackers", steps: 3, label: "闲家队升 3 级" });
});

test("AI 可以补座并自动推进无人叫庄流程", () => {
  const room = createRoom("AI");
  for (let i = 0; i < 5; i += 1) addAiPlayer(room, i, "medium");
  startRound(room, () => 0.2);
  startAuction(room);
  // No one bid → the server reveals the 7 kitty cards to force a dealer.
  let safety = 0;
  while (room.phase === "auction" && safety++ < 10) revealKittyCard(room);
  if (room.forceSpin) room.forceSpin.startedAt = Date.now() - room.forceSpin.count * room.forceSpin.intervalMs - 1;
  // From here AI advances forcedSuit → burying → friend → playing. The forced
  // dealer's decision is via runAiStep; the open-亮 responses from the other
  // seats are server-paced (scheduleAiBids), so drive those declines explicitly.
  let guard = 0;
  while (guard++ < 200) {
    if (runAiStep(room)) continue;
    if (room.phase === "forcedSuit") {
      let acted = false;
      for (const seat of room.seats) {
        if (seat.index !== room.dealerSeat && !room.bidResponses[seat.index]) {
          passBid(room, seat.playerId);
          acted = true;
        }
      }
      if (acted) continue;
    }
    break;
  }
  assert.ok(["burying", "friend", "playing", "roundOver"].includes(room.phase));
});

test("AI 叫朋友不会把自己当成朋友", () => {
  const room = createRoom("FR");
  room.levelRank = "2";
  room.trumpSuit = "hearts";
  const deck = createDeck();
  const dealer = room.seats[0];
  dealer.playerId = "d"; dealer.isAi = true; dealer.aiLevel = "medium"; dealer.level = "2";
  // Dealer already holds all 3 ♠A and one ♣K — the called card must be one the
  // dealer cannot complete alone (held copies < ordinal).
  dealer.hand = [
    ...deck.filter((c) => c.rank === "A" && c.suit === "spades").slice(0, 3),
    ...deck.filter((c) => c.rank === "K" && c.suit === "clubs").slice(0, 1)
  ];
  const call = chooseAiFriendCard(room, dealer);
  const held = dealer.hand.filter((c) =>
    c.rank === call.rank && (call.suit === "joker" ? true : c.suit === call.suit)).length;
  assert.ok(held < call.ordinal, "庄家自己持有的数量必须少于朋友牌序号，否则会 4 打 1");
  assert.ok(call.ordinal >= 1 && call.ordinal <= 3);
});

test("大师庄家叫朋友优先叫副牌 A，常主 A 时改叫 K", () => {
  const deck = createDeck();

  const room = createRoom("FRMASTER");
  room.levelRank = "7";
  room.trumpSuit = "hearts";
  const dealer = room.seats[0];
  dealer.playerId = "d"; dealer.isAi = true; dealer.aiLevel = "master"; dealer.level = "7";
  dealer.hand = [
    ...deck.filter((c) => c.rank === "A" && c.suit === "spades").slice(0, 1),
    ...deck.filter((c) => c.rank === "K" && c.suit === "clubs").slice(0, 1)
  ];
  assert.deepEqual(chooseAiFriendCard(room, dealer), { ordinal: 2, rank: "A", suit: "spades" });

  const aceRoom = createRoom("FRMASTERACE");
  aceRoom.levelRank = "A";
  aceRoom.trumpSuit = "hearts";
  const aceDealer = aceRoom.seats[0];
  aceDealer.playerId = "d"; aceDealer.isAi = true; aceDealer.aiLevel = "master"; aceDealer.level = "A";
  aceDealer.hand = [
    ...deck.filter((c) => c.rank === "K" && c.suit === "diamonds").slice(0, 1),
    ...deck.filter((c) => c.rank === "Q" && c.suit === "clubs").slice(0, 1)
  ];
  assert.deepEqual(chooseAiFriendCard(aceRoom, aceDealer), { ordinal: 2, rank: "K", suit: "diamonds" });
});

test("AI 跟牌不会把分牌送给对家", () => {
  const room = createRoom("PT");
  room.levelRank = "2";
  room.trumpSuit = "hearts";
  room.dealerSeat = 0;        // seat 0 leads and is an enemy of the AI
  room.friendSeat = null;
  const deck = createDeck();
  const spadeK = deck.find((c) => c.rank === "K" && c.suit === "spades");
  const spade5 = deck.find((c) => c.rank === "5" && c.suit === "spades");
  const spade3 = deck.find((c) => c.rank === "3" && c.suit === "spades");
  room.seats[0].playerId = "e0";
  const ai = room.seats[1];
  ai.playerId = "ai1"; ai.isAi = true; ai.aiLevel = "medium";
  ai.hand = [spade5, spade3];
  room.currentTrick = [{ seat: 0, cards: [spadeK], shape: analyzeShape([spadeK], room), points: 10 }];
  room.turnSeat = 1;
  const play = chooseAiPlay(room, ai, [spadeK]);
  assert.equal(play.length, 1);
  assert.equal(play[0].rank, "3"); // dump the 3, never feed the 5 to an enemy
});

test("潜在朋友确认自己是队友后，会给庄家稳张上分", () => {
  const room = createRoom("SECRETFR");
  room.levelRank = "2";
  room.trumpSuit = "hearts";
  room.dealerSeat = 0;
  room.friendSeat = null;
  room.friendCall = { ordinal: 2, rank: "A", suit: "spades" };
  const deck = createDeck();
  const dealerA = deck.find((c) => c.rank === "A" && c.suit === "spades");
  const friendAs = deck.filter((c) => c.rank === "A" && c.suit === "spades").slice(1, 3);
  const spadeK = deck.find((c) => c.rank === "K" && c.suit === "spades");
  const spade9 = deck.find((c) => c.rank === "9" && c.suit === "spades");
  room.seats[0].playerId = "d";
  const ai = room.seats[1];
  ai.playerId = "ai1"; ai.isAi = true; ai.aiLevel = "master";
  ai.hand = [...friendAs, spadeK, spade9];
  room.currentTrick = [{ seat: 0, cards: [dealerA], shape: analyzeShape([dealerA], room), points: 0 }];
  room.turnSeat = 1;

  const play = chooseAiPlay(room, ai, [dealerA]);

  assert.equal(play.length, 1);
  assert.equal(play[0].rank, "K", "已知自己是朋友时，应把分上给庄家的 A");
});

test("AI 跟单张时优先出自然单张最小非分牌，不拆对子", () => {
  const room = createRoom("SINGLE1");
  room.levelRank = "2";
  room.trumpSuit = "hearts";
  room.dealerSeat = 0;
  room.friendSeat = null;
  const deck = createDeck();
  const cardsOf = (rank, suit, n = 1) => deck.filter((c) => c.rank === rank && c.suit === suit).slice(0, n);
  const lead = cardsOf("A", "spades", 1)[0];
  room.seats[0].playerId = "e0";
  const ai = room.seats[1];
  ai.playerId = "ai1"; ai.isAi = true; ai.aiLevel = "medium";
  ai.hand = [
    ...cardsOf("4", "spades", 2),
    ...["5", "6", "7", "8"].map((rank) => cardsOf(rank, "spades", 1)[0])
  ];
  room.currentTrick = [{ seat: 0, cards: [lead], shape: analyzeShape([lead], room), points: 0 }];
  room.turnSeat = 1;
  const play = chooseAiPlay(room, ai, [lead]);
  assert.equal(play.length, 1);
  assert.equal(play[0].rank, "6");
});

test("AI 跟单张时自然单张只有分牌，才考虑拆对子出非分牌", () => {
  const room = createRoom("SINGLE2");
  room.levelRank = "2";
  room.trumpSuit = "hearts";
  room.dealerSeat = 0;
  room.friendSeat = null;
  const deck = createDeck();
  const cardsOf = (rank, suit, n = 1) => deck.filter((c) => c.rank === rank && c.suit === suit).slice(0, n);
  const lead = cardsOf("A", "spades", 1)[0];
  room.seats[0].playerId = "e0";
  const ai = room.seats[1];
  ai.playerId = "ai1"; ai.isAi = true; ai.aiLevel = "medium";
  ai.hand = [
    ...cardsOf("4", "spades", 2),
    cardsOf("5", "spades", 1)[0],
    cardsOf("10", "spades", 1)[0]
  ];
  room.currentTrick = [{ seat: 0, cards: [lead], shape: analyzeShape([lead], room), points: 0 }];
  room.turnSeat = 1;
  const play = chooseAiPlay(room, ai, [lead]);
  assert.equal(play.length, 1);
  assert.equal(play[0].rank, "4");
});

test("推荐跟单张时选择自然单张最小非分牌", () => {
  const room = createRoom("HINTSINGLE1");
  room.phase = "playing";
  room.levelRank = "2";
  room.trumpSuit = "hearts";
  const deck = createDeck();
  const cardsOf = (rank, suit, n = 1) => deck.filter((c) => c.rank === rank && c.suit === suit).slice(0, n);
  const lead = cardsOf("A", "spades", 1)[0];
  room.seats[0].playerId = "p0";
  const seat = room.seats[1];
  seat.playerId = "p1";
  seat.hand = [
    ...cardsOf("4", "spades", 2),
    ...["5", "6", "7", "8"].map((rank) => cardsOf(rank, "spades", 1)[0])
  ];
  room.currentTrick = [{ seat: 0, cards: [lead], shape: analyzeShape([lead], room), points: 0 }];
  room.turnSeat = 1;
  const ids = recommendPlay(room, "p1");
  const card = seat.hand.find((c) => c.id === ids[0]);
  assert.equal(ids.length, 1);
  assert.equal(card.rank, "6");
});

test("推荐默认不带分，必要带分时从小到大", () => {
  const room = createRoom("HINTPOINTS");
  room.phase = "playing";
  room.levelRank = "2";
  room.trumpSuit = "hearts";
  const deck = createDeck();
  const cardsOf = (rank, suit, n = 1) => deck.filter((c) => c.rank === rank && c.suit === suit).slice(0, n);
  const lead = cardsOf("A", "clubs", 1)[0];
  room.seats[0].playerId = "p0";
  const seat = room.seats[1];
  seat.playerId = "p1";
  seat.hand = [cardsOf("5", "clubs", 1)[0], cardsOf("10", "clubs", 1)[0], cardsOf("K", "clubs", 1)[0]];
  room.currentTrick = [{ seat: 0, cards: [lead], shape: analyzeShape([lead], room), points: 0 }];
  room.turnSeat = 1;
  const ids = recommendPlay(room, "p1");
  const card = seat.hand.find((c) => c.id === ids[0]);
  assert.equal(ids.length, 1);
  assert.equal(card.rank, "5");
});

test("推荐首出时避开分牌，先出最小非分单张", () => {
  const room = createRoom("HINTLEAD");
  room.phase = "playing";
  room.levelRank = "2";
  room.trumpSuit = "hearts";
  const deck = createDeck();
  const card = (rank, suit) => deck.find((c) => c.rank === rank && c.suit === suit);
  const seat = room.seats[0];
  seat.playerId = "p0";
  seat.hand = [card("5", "spades"), card("6", "spades"), card("10", "clubs")];
  room.currentTrick = [];
  room.turnSeat = 0;
  const ids = recommendPlay(room, "p0");
  const recommended = seat.hand.find((c) => c.id === ids[0]);
  assert.equal(ids.length, 1);
  assert.equal(recommended.rank, "6");
});

test("AI 抢庄只用手里真实的常主牌", () => {
  const room = createRoom("BID");
  const deck = createDeck();
  const seat = room.seats[0];
  seat.playerId = "a"; seat.isAi = true; seat.aiLevel = "hard"; seat.level = "K";
  seat.hand = [
    ...deck.filter((c) => c.rank === "K" && c.suit === "spades").slice(0, 2),       // 2 级牌(同花)
    ...deck.filter((c) => c.suit === "spades" && c.rank !== "K").slice(0, 18),       // 一堆黑桃
    ...deck.filter((c) => c.suit === "joker").slice(0, 2)                            // 2 王
  ];
  const decision = decideAiBid(room, seat);
  assert.ok(decision, "强主牌手应当抢庄");
  assert.equal(decision.cardIds.length, decision.strength);
  for (const id of decision.cardIds) {
    const c = seat.hand.find((x) => x.id === id);
    assert.ok(c && c.rank === "K" && c.suit === "spades"); // 只用手里的同花级牌
  }
});

test("弱 AI 为测试不主动亮主", () => {
  const room = createRoom("EASYBID");
  const deck = createDeck();
  const seat = room.seats[0];
  seat.playerId = "a"; seat.isAi = true; seat.aiLevel = "easy"; seat.level = "K";
  seat.hand = [
    ...deck.filter((c) => c.rank === "K" && c.suit === "spades").slice(0, 3),
    ...deck.filter((c) => c.suit === "spades" && c.rank !== "K").slice(0, 20),
    ...deck.filter((c) => c.suit === "joker").slice(0, 3)
  ];

  assert.equal(decideAiBid(room, seat), null);
});

test("AI 领牌会兑现确定的赢张（基础）", () => {
  const room = createRoom("CASH");
  room.levelRank = "2"; room.trumpSuit = "hearts"; room.dealerSeat = 1; room.friendSeat = null;
  const deck = createDeck();
  const spadeA = deck.find((c) => c.rank === "A" && c.suit === "spades"); // 副牌最大、必赢
  const lows = [deck.find((c) => c.rank === "4" && c.suit === "clubs"),
                deck.find((c) => c.rank === "6" && c.suit === "clubs"),
                deck.find((c) => c.rank === "3" && c.suit === "diamonds")];
  const ai = room.seats[1];
  ai.playerId = "ai1"; ai.isAi = true; ai.aiLevel = "medium";
  ai.hand = [spadeA, ...lows];
  let cashes = 0;
  for (let k = 0; k < 40; k++) { ai.aiRngState = (k * 2654435761) | 0; const p = chooseAiPlay(room, ai, null); if (p.length === 1 && p[0].rank === "A") cashes++; }
  assert.ok(cashes > 30, `应当通常兑现黑桃A，实际 ${cashes}/40`);
});

test("大师首出优先兑现副牌大组合，而不是无意义小单张", () => {
  const room = createRoom("MASTERLEAD");
  room.levelRank = "2"; room.trumpSuit = "hearts"; room.dealerSeat = 1; room.friendSeat = null;
  const deck = createDeck();
  const ai = room.seats[0];
  ai.playerId = "ai0"; ai.isAi = true; ai.aiLevel = "master";
  ai.hand = [
    ...deck.filter((c) => c.rank === "A" && c.suit === "spades").slice(0, 2),
    deck.find((c) => c.rank === "3" && c.suit === "clubs"),
    deck.find((c) => c.rank === "4" && c.suit === "diamonds")
  ];

  const play = chooseAiPlay(room, ai, null);

  assert.equal(play.length, 2);
  assert.equal(play.every((c) => c.rank === "A" && c.suit === "spades"), true);
});

test("大师首出会优先尝试副牌对子，即使未必绝对最大", () => {
  const room = createRoom("MASTERPAIR");
  room.levelRank = "2"; room.trumpSuit = "hearts"; room.dealerSeat = 1; room.friendSeat = null;
  const deck = createDeck();
  const ai = room.seats[0];
  ai.playerId = "ai0"; ai.isAi = true; ai.aiLevel = "master";
  ai.hand = [
    ...deck.filter((c) => c.rank === "K" && c.suit === "spades").slice(0, 2),
    deck.find((c) => c.rank === "3" && c.suit === "clubs"),
    deck.find((c) => c.rank === "4" && c.suit === "diamonds")
  ];

  const play = chooseAiPlay(room, ai, null);

  assert.equal(play.length, 2);
  assert.equal(play.every((c) => c.rank === "K" && c.suit === "spades"), true);
});

test("AI 垫牌优先做空门（基础）", () => {
  const room = createRoom("VOID");
  room.levelRank = "2"; room.trumpSuit = "hearts"; room.dealerSeat = 0; room.friendSeat = null;
  const deck = createDeck();
  const spadeK = deck.find((c) => c.rank === "K" && c.suit === "spades"); // 敌家领黑桃
  const club3 = deck.find((c) => c.rank === "3" && c.suit === "clubs");   // 短门（仅此一张梅花）
  const diamonds = [deck.find((c) => c.rank === "4" && c.suit === "diamonds"),
                    deck.find((c) => c.rank === "6" && c.suit === "diamonds")];
  room.seats[0].playerId = "e0";
  const ai = room.seats[1];
  ai.playerId = "ai1"; ai.isAi = true; ai.aiLevel = "medium";
  ai.hand = [club3, ...diamonds]; // 黑桃缺门、无主，只能垫牌
  room.currentTrick = [{ seat: 0, cards: [spadeK], shape: analyzeShape([spadeK], room), points: 10 }];
  room.turnSeat = 1;
  let voided = 0;
  for (let k = 0; k < 40; k++) { ai.aiRngState = (k * 40503 + 7) | 0; const p = chooseAiPlay(room, ai, [spadeK]); if (p.length === 1 && p[0].suit === "clubs") voided++; }
  assert.ok(voided > 30, `应当优先垫掉短门梅花做空门，实际 ${voided}/40`);
});

test("三条锁定剩两张时不死锁：锁定对不强制跟对，单张合法", () => {
  // 复刻 bench seed 75×7919 的死锁：锁定三条只剩两张、恰是该门唯一天然对子。
  const room = createRoom("LOCK1");
  room.levelRank = "7"; room.trumpSuit = "hearts"; room.dealerSeat = 0; room.friendSeat = null;
  const deck = createDeck();
  const bigJokers = deck.filter((c) => c.rank === "bigJoker").slice(0, 2); // 敌家领对大王（主牌对）
  room.seats[0].playerId = "e0";
  const ai = room.seats[1];
  ai.playerId = "ai1"; ai.isAi = true; ai.aiLevel = "medium";
  ai.hand = [
    ...deck.filter((c) => c.rank === "6" && c.suit === "hearts").slice(0, 2), // 锁定三条剩两张
    deck.find((c) => c.rank === "A" && c.suit === "hearts"),
    deck.find((c) => c.rank === "Q" && c.suit === "hearts"),
    deck.find((c) => c.rank === "9" && c.suit === "hearts"),
    deck.find((c) => c.rank === "8" && c.suit === "spades")
  ];
  ai.lockedTriples = ["6|hearts"];
  room.currentTrick = [{ seat: 0, cards: bigJokers, shape: analyzeShape(bigJokers, room), points: 0 }];
  room.turnSeat = 1;
  // 锁定对不计入“必须跟对”→ 两张主牌单张合法
  assert.equal(validatePlay(room, ai, [ai.hand[2], ai.hand[3]], bigJokers).ok, true);
  // 锁定的两张同点牌可以作为“两张单牌”跟出，不再被误判成拆对子。
  assert.equal(validatePlay(room, ai, ai.hand.slice(0, 2), bigJokers).ok, true);
  // AI 必须给出一手合法牌
  const play = chooseAiPlay(room, ai, bigJokers);
  assert.equal(validatePlay(room, ai, play, bigJokers).ok, true);
});

test("三条锁定后：有天然对子可跟时，锁定两张不能冒充对子", () => {
  const room = createRoom("LOCKPAIRBLOCK");
  room.levelRank = "7"; room.trumpSuit = "hearts"; room.dealerSeat = 0; room.friendSeat = null;
  const deck = createDeck();
  const lead = deck.filter((c) => c.rank === "A" && c.suit === "spades").slice(0, 2);
  const locked8 = deck.filter((c) => c.rank === "8" && c.suit === "spades").slice(0, 2);
  const natural6 = deck.filter((c) => c.rank === "6" && c.suit === "spades").slice(0, 2);
  room.seats[0].playerId = "p0";
  const me = room.seats[1];
  me.playerId = "p1";
  me.hand = [...locked8, ...natural6];
  me.lockedTriples = ["8|spades"];
  room.currentTrick = [{ seat: 0, cards: lead, shape: analyzeShape(lead, room), points: 0 }];

  assert.equal(validatePlay(room, me, locked8, lead).ok, false, "有天然对子 66 时，锁定 88 不能当对子跟");
  assert.equal(validatePlay(room, me, natural6, lead).ok, true, "应改出天然对子 66");
});

test("三条锁定剩两张时不死锁：跟三条领出同样有合法出牌", () => {
  // 复刻 bench seed 17×7919 的死锁：三条领出，跟家唯一对子是锁定对。
  const room = createRoom("LOCK2");
  room.levelRank = "A"; room.trumpSuit = "spades"; room.dealerSeat = 0; room.friendSeat = null;
  const deck = createDeck();
  const club3s = deck.filter((c) => c.rank === "3" && c.suit === "clubs").slice(0, 3); // 敌家领梅花333
  room.seats[0].playerId = "e0";
  const ai = room.seats[1];
  ai.playerId = "ai1"; ai.isAi = true; ai.aiLevel = "medium";
  ai.hand = [
    deck.find((c) => c.rank === "Q" && c.suit === "clubs"),
    deck.find((c) => c.rank === "8" && c.suit === "clubs"),
    ...deck.filter((c) => c.rank === "7" && c.suit === "clubs").slice(0, 2), // 锁定三条剩两张
    deck.find((c) => c.rank === "5" && c.suit === "clubs"),
    deck.find((c) => c.rank === "9" && c.suit === "diamonds")
  ];
  ai.lockedTriples = ["7|clubs"];
  room.currentTrick = [{ seat: 0, cards: club3s, shape: analyzeShape(club3s, room), points: 0 }];
  room.turnSeat = 1;
  // 锁定对不计入“必须跟对”→ 三张梅花单张合法
  assert.equal(validatePlay(room, ai, [ai.hand[0], ai.hand[1], ai.hand[4]], club3s).ok, true);
  // 含锁定两张的跟牌可按两张单牌处理，不再误判为拆对子
  assert.equal(validatePlay(room, ai, [ai.hand[2], ai.hand[3], ai.hand[0]], club3s).ok, true);
  // AI 必须给出一手合法牌
  const play = chooseAiPlay(room, ai, club3s);
  assert.equal(validatePlay(room, ai, play, club3s).ok, true);
});

// 三条跟对子的"拆/不拆"与锁定规则（5/6 人三副牌）：
//  - 同门还有自然对子 → 跟那对，三条不锁，之后自由处置。
//  - 同门无别的对子 → 可拆(出对)也可不拆(出单)；不拆则锁定，之后不能再拆成对。
//  - "别的对子"在异门不算（必须跟同门）。
function tripleFollowSetup(handFilter) {
  const room = createRoom("TRIP");
  room.levelRank = "2"; room.trumpSuit = "hearts"; room.dealerSeat = 0; room.friendSeat = null;
  room.phase = "playing";
  const deck = createDeck();
  const lead = deck.filter((c) => c.rank === "5" && c.suit === "spades").slice(0, 2);
  room.seats[0].playerId = "p0";
  const me = room.seats[1];
  me.playerId = "me"; me.lockedTriples = []; me.hand = handFilter(deck);
  room.currentTrick = [{ seat: 0, cards: lead, shape: analyzeShape(lead, room), points: 0 }];
  room.currentLeader = 0; room.turnSeat = 1;
  return { room, me, lead, deck };
}
const spadesOf = (deck, rank, n) => deck.filter((c) => c.rank === rank && c.suit === "spades").slice(0, n);

test("三条跟对子：同门有别的对子→跟对不锁三条（之后可自由处置）", () => {
  const { room, me, lead, deck } = tripleFollowSetup((d) => [...spadesOf(d, "J", 3), ...spadesOf(d, "9", 2), ...spadesOf(d, "8", 1)]);
  assert.equal(validatePlay(room, me, spadesOf(deck, "9", 2), lead).ok, true, "跟自然对子 99 合法");
  // 有自然对子时不许用两张单张垫
  assert.equal(validatePlay(room, me, [spadesOf(deck, "J", 1)[0], spadesOf(deck, "8", 1)[0]], lead).ok, false);
  playCards(room, "me", spadesOf(deck, "9", 2).map((c) => c.id));
  assert.deepEqual(me.lockedTriples, [], "出 99 后三条不被锁定");
});

test("三条跟对子：同门无别的对子→不拆则锁定、拆则不锁", () => {
  // 不拆：出 J + 单张7
  {
    const { room, me, lead, deck } = tripleFollowSetup((d) => [...spadesOf(d, "J", 3), ...spadesOf(d, "7", 1)]);
    const J7 = [spadesOf(deck, "J", 1)[0], spadesOf(deck, "7", 1)[0]];
    assert.equal(validatePlay(room, me, J7, lead).ok, true, "不拆三条出 J7 合法");
    playCards(room, "me", J7.map((c) => c.id));
    assert.deepEqual(me.lockedTriples, ["J|spades"], "不拆 → 锁定 J|spades");
  }
  // 拆：出 JJ
  {
    const { room, me, lead, deck } = tripleFollowSetup((d) => [...spadesOf(d, "J", 3), ...spadesOf(d, "7", 1)]);
    const JJ = spadesOf(deck, "J", 2);
    assert.equal(validatePlay(room, me, JJ, lead).ok, true, "拆三条出 JJ 合法");
    playCards(room, "me", JJ.map((c) => c.id));
    assert.deepEqual(me.lockedTriples, [], "拆了 → 不锁定");
  }
});

test("三条跟对子：异门对子不算，仍需面对拆/不拆（不拆则锁）", () => {
  const { room, me, lead, deck } = tripleFollowSetup((d) => [
    ...spadesOf(d, "J", 3), ...spadesOf(d, "7", 1),
    ...d.filter((c) => c.rank === "9" && c.suit === "clubs").slice(0, 2) // 异门对子
  ]);
  const clubPair = deck.filter((c) => c.rank === "9" && c.suit === "clubs").slice(0, 2);
  assert.equal(validatePlay(room, me, clubPair, lead).ok, false, "异门对子非法（必须跟黑桃）");
  const J7 = [spadesOf(deck, "J", 1)[0], spadesOf(deck, "7", 1)[0]];
  playCards(room, "me", J7.map((c) => c.id));
  assert.deepEqual(me.lockedTriples, ["J|spades"], "异门的对救不了三条，不拆仍锁定");
});

test("盖庄后清空其他座位旧响应，不提前定庄、被盖者保留再抢机会", () => {
  const room = createRoom("BID2");
  const deck = createDeck();
  for (let i = 0; i < 5; i += 1) {
    const s = room.seats[i];
    s.playerId = `p${i}`; s.nickname = `P${i}`; s.level = "2";
  }
  room.phase = "auction"; room.dealing = false;
  const h2 = deck.filter((c) => c.rank === "2" && c.suit === "hearts"); // 三副牌共 3 张
  room.seats[1].hand = [h2[0]];        // 单张级牌 → 强度1
  room.seats[3].hand = [h2[1], h2[2]]; // 一对级牌 → 强度2

  makeBid(room, "p1", [h2[0].id]);     // seat1 先亮 1 张
  passBid(room, "p0");
  passBid(room, "p2");
  makeBid(room, "p3", [h2[1].id, h2[2].id]); // seat3 用更高强度盖庄
  passBid(room, "p4");

  // 盖庄后旧的 pass/bid 必须清空，只保留盖庄者；故 4 人响应数 < 5，绝不提前定庄。
  assert.equal(room.phase, "auction", "盖庄后不应因陈旧响应提前定庄");
  assert.deepEqual(Object.keys(room.bidResponses).sort(), ["3", "4"]);
  assert.equal(1 in room.bidResponses, false, "被盖庄的 seat1 应重新获得表态机会");
  assert.equal(room.currentBid.seat, 3);
});

test("强制坐庄确认花色后，公开亮牌展示用的花色和牌数", () => {
  const room = createRoom("FORCEDSHOW");
  const deck = createDeck();
  for (let i = 0; i < 5; i += 1) {
    const seat = room.seats[i];
    seat.playerId = `p${i}`;
    seat.nickname = `P${i}`;
    seat.level = "7";
  }
  room.starterSeat = 0;
  const lastKittyCard = deck.find((c) => c.rank === "A" && c.suit === "spades");
  forceDealer(room, lastKittyCard);
  room.forceSpin.startedAt = Date.now() - room.forceSpin.count * room.forceSpin.intervalMs - 1;
  const dealer = room.seats[room.dealerSeat];
  dealer.hand = deck.filter((c) => c.rank === "7" && c.suit === "hearts").slice(0, 2);
  chooseForcedTrump(room, dealer.playerId, "hearts");
  const state = publicState(room, dealer.playerId);

  assert.equal(state.currentBid.trumpSuit, "hearts");
  assert.equal(state.currentBid.cards.length, 2);
  assert.equal(state.currentBid.cards.every((c) => c.rank === "7" && c.suit === "hearts"), true);
});

test("翻底强制坐庄公开轮盘动画起点、步数和目标", () => {
  const room = createRoom("FORCESPIN");
  const deck = createDeck();
  for (let i = 0; i < 5; i += 1) {
    room.seats[i].playerId = `p${i}`;
    room.seats[i].nickname = `P${i}`;
    room.seats[i].level = "7";
  }
  room.starterSeat = 0;
  const lastKittyCard = deck.find((c) => c.rank === "5" && c.suit === "clubs");
  forceDealer(room, lastKittyCard);
  const state = publicState(room, "p0");

  assert.equal(room.dealerSeat, 4, "从首摸座位数 5 下应停在第 5 家");
  assert.equal(state.forceSpin.startSeat, 0);
  assert.equal(state.forceSpin.count, 5);
  assert.equal(state.forceSpin.targetSeat, 4);
  assert.equal(state.forceSpin.intervalMs, 1000);
  assert.equal(state.forceSpin.holdMs, 1500);
  assert.equal(state.forceSpin.card.rank, "5");
  // 最后一张底牌只在中央轮盘面板（forceSpin.card）显示，不挂到被迫庄家头顶（seatBids），
  // 以免被误解成他亮的花色牌。
  assert.equal(state.seatBids["4"], undefined, "翻出的底牌不应显示在庄家座位上");
});

test("翻底强制坐庄：大小王按 0 点停在第一个摸牌人", () => {
  for (const rank of ["smallJoker", "bigJoker"]) {
    const room = createRoom(`FORCE${rank}`);
    const deck = createDeck();
    for (let i = 0; i < 5; i += 1) {
      room.seats[i].playerId = `p${i}`;
      room.seats[i].nickname = `P${i}`;
      room.seats[i].level = "7";
    }
    room.starterSeat = 2;
    const lastKittyCard = deck.find((c) => c.rank === rank);
    forceDealer(room, lastKittyCard);
    const state = publicState(room, "p2");

    assert.equal(room.dealerSeat, 2, `${rank} 为 0 点，应停在 starterSeat`);
    assert.equal(state.forceSpin.startSeat, 2);
    assert.equal(state.forceSpin.count, 0);
    assert.equal(state.forceSpin.targetSeat, 2);
    assert.equal(state.forceSpin.card.rank, rank);
    assert.equal(room.noTrump, true);
  }
});

test("翻底轮盘倒计时结束前不能亮主或定主", () => {
  const room = createRoom("FORCEWAIT");
  const deck = createDeck();
  for (let i = 0; i < 5; i += 1) {
    room.seats[i].playerId = `p${i}`;
    room.seats[i].nickname = `P${i}`;
    room.seats[i].level = "7";
  }
  room.starterSeat = 0;
  const lastKittyCard = deck.find((c) => c.rank === "5" && c.suit === "clubs");
  forceDealer(room, lastKittyCard);
  const bidCard = deck.find((c) => c.rank === "7" && c.suit === "hearts");
  room.seats[1].hand = [bidCard];
  assert.throws(() => makeBid(room, "p1", [bidCard.id]), /轮盘倒计时/);
  assert.throws(() => chooseForcedTrump(room, room.seats[room.dealerSeat].playerId, null), /轮盘倒计时/);
});

test("强制定主阶段：其他玩家亮主接管后需全员表态才定庄", () => {
  const room = createRoom("FORCEBID");
  const deck = createDeck();
  for (let i = 0; i < 5; i += 1) {
    room.seats[i].playerId = `p${i}`;
    room.seats[i].nickname = `P${i}`;
    room.seats[i].level = "7";
  }
  room.starterSeat = 0;
  room.kitty = deck.filter((c) => c.rank === "3").slice(0, 7);
  const lastKittyCard = deck.find((c) => c.rank === "5" && c.suit === "clubs");
  forceDealer(room, lastKittyCard);
  room.forceSpin.startedAt = Date.now() - room.forceSpin.count * room.forceSpin.intervalMs - 1;
  assert.equal(room.dealerSeat, 4);
  const bidCard = deck.find((c) => c.rank === "7" && c.suit === "hearts");
  room.seats[1].hand = [bidCard];

  makeBid(room, "p1", [bidCard.id]);

  // 盖庄者成为新庄家，但开放亮主响应窗口，尚未定庄
  assert.equal(room.phase, "forcedSuit");
  assert.equal(room.dealerSeat, 1);
  assert.equal(room.trumpSuit, "hearts");
  assert.equal(room.forceSpin, null);

  // 其他人都不亮 → 定庄进入扣底
  for (const pid of ["p0", "p2", "p3", "p4"]) passBid(room, pid);
  assert.equal(room.phase, "burying");
  assert.equal(room.dealerSeat, 1);
  assert.equal(room.seats[1].hand.length, 8, "新庄应拿起 7 张底牌");
});

test("强制定主阶段：强制庄不亮且无人亮主，按底牌花色定庄", () => {
  const room = createRoom("FORCEKEEP");
  const deck = createDeck();
  for (let i = 0; i < 5; i += 1) {
    room.seats[i].playerId = `p${i}`;
    room.seats[i].nickname = `P${i}`;
    room.seats[i].level = "7";
  }
  room.starterSeat = 0;
  room.kitty = deck.filter((c) => c.rank === "3").slice(0, 7);
  const lastKittyCard = deck.find((c) => c.rank === "5" && c.suit === "clubs");
  forceDealer(room, lastKittyCard);
  room.forceSpin.startedAt = Date.now() - room.forceSpin.count * room.forceSpin.intervalMs - 1;
  const dealerId = room.seats[room.dealerSeat].playerId;

  // 强制庄选择不亮（沿用底牌花色），其余人不亮
  chooseForcedTrump(room, dealerId, null);
  assert.equal(room.phase, "forcedSuit", "庄家不亮后仍开放窗口给其他人");
  for (const seat of room.seats) {
    if (seat.index !== room.dealerSeat) passBid(room, seat.playerId);
  }
  assert.equal(room.phase, "burying");
  assert.equal(room.dealerSeat, 4, "无人亮主则强制庄保留庄家");
  assert.equal(room.trumpSuit, "clubs", "沿用底牌花色");
});

test("强制定主阶段：强制庄亮主后可被更高亮主盖过", () => {
  const room = createRoom("FORCEOVER");
  const deck = createDeck();
  for (let i = 0; i < 5; i += 1) {
    room.seats[i].playerId = `p${i}`;
    room.seats[i].nickname = `P${i}`;
    room.seats[i].level = "7";
  }
  room.starterSeat = 0;
  room.kitty = deck.filter((c) => c.rank === "3").slice(0, 7);
  const lastKittyCard = deck.find((c) => c.rank === "5" && c.suit === "clubs");
  forceDealer(room, lastKittyCard);
  room.forceSpin.startedAt = Date.now() - room.forceSpin.count * room.forceSpin.intervalMs - 1;
  const dealerSeat = room.dealerSeat;
  const dealerId = room.seats[dealerSeat].playerId;

  // 强制庄亮 1 张红桃 7
  room.seats[dealerSeat].hand = [deck.find((c) => c.rank === "7" && c.suit === "hearts")];
  chooseForcedTrump(room, dealerId, "hearts");
  assert.equal(room.dealerSeat, dealerSeat);
  assert.equal(room.trumpSuit, "hearts");

  // 另一人用 2 张红桃 7 盖更高（同花色更多张，两副牌各一张）
  const overSeat = (dealerSeat + 1) % 5;
  const hearts7 = deck.filter((c) => c.rank === "7" && c.suit === "hearts");
  room.seats[overSeat].hand = hearts7.slice(0, 2);
  makeBid(room, room.seats[overSeat].playerId, hearts7.slice(0, 2).map((c) => c.id));
  assert.equal(room.dealerSeat, overSeat, "更高亮主者接管庄家");

  for (const seat of room.seats) {
    if (seat.index !== overSeat && !room.bidResponses[seat.index]) passBid(room, seat.playerId);
  }
  assert.equal(room.phase, "burying");
  assert.equal(room.dealerSeat, overSeat);
});

test("5人翻底定红桃后，他人可用3张王亮无主盖过并夺庄", () => {
  const room = createRoom("FORCENT");
  const deck = createDeck();
  assert.equal(room.seatCount, 5, "默认即 5 人找朋友");
  for (let i = 0; i < 5; i += 1) {
    room.seats[i].playerId = `p${i}`;
    room.seats[i].nickname = `P${i}`;
    room.seats[i].level = "7";
  }
  room.starterSeat = 0;
  room.kitty = deck.filter((c) => c.rank === "3").slice(0, 7);
  // 底牌最后一张是红桃 → 主花色默认红桃
  const lastKittyCard = deck.find((c) => c.rank === "5" && c.suit === "hearts");
  forceDealer(room, lastKittyCard);
  room.forceSpin.startedAt = Date.now() - room.forceSpin.count * room.forceSpin.intervalMs - 1;
  const forcedDealer = room.dealerSeat;
  assert.equal(room.trumpSuit, "hearts", "翻底默认主花色为红桃");

  // 强制庄不亮，沿用红桃
  chooseForcedTrump(room, room.seats[forcedDealer].playerId, null);
  assert.equal(room.trumpSuit, "hearts");

  // 另一人看见红桃后，用 3 张王亮无主（强度 4/5 > 任何花色 ≤3）盖过并夺庄
  const ntSeat = (forcedDealer + 2) % 5;
  const jokers = [
    ...deck.filter((c) => c.rank === "bigJoker"),
    ...deck.filter((c) => c.rank === "smallJoker")
  ].slice(0, 3);
  assert.equal(jokers.length, 3, "两副牌足够凑 3 张王");
  room.seats[ntSeat].hand = jokers;
  makeBid(room, room.seats[ntSeat].playerId, jokers.map((c) => c.id));
  assert.equal(room.dealerSeat, ntSeat, "亮无主者夺庄");
  assert.equal(room.noTrump, true, "改打无主");
  assert.equal(room.trumpSuit, null);

  // 其余人都不亮 → 定庄进入扣底，庄已易主、主为无主
  for (const seat of room.seats) {
    if (seat.index !== ntSeat && !room.bidResponses[seat.index]) passBid(room, seat.playerId);
  }
  assert.equal(room.phase, "burying");
  assert.equal(room.dealerSeat, ntSeat);
  assert.equal(room.noTrump, true);
});

test("甩牌失败罚分随朋友现身重算，并公开闲家扣分统计", () => {
  const room = createRoom("PENALTYMOVE");
  for (let i = 0; i < 5; i += 1) {
    room.seats[i].playerId = `p${i}`;
    room.seats[i].nickname = `P${i}`;
  }
  room.dealerSeat = 0;
  room.friendSeat = null;
  room.seatPersonalScores = { 1: -10 };
  recomputeScores(room);
  assert.equal(room.scores.attackers, 0);
  assert.deepEqual(room.throwPenaltyStats, { attackers: 10, dealerTeam: 0, netToAttackers: -10 });

  room.friendSeat = 1;
  recomputeScores(room);
  assert.equal(room.scores.attackers, 10);
  assert.deepEqual(publicState(room, "p0").throwPenaltyStats, { attackers: 0, dealerTeam: 10, netToAttackers: 10 });
  room.seatPersonalScores[1] -= 10;
  recomputeScores(room);
  assert.equal(publicState(room, "p0").seatPersonalScores[1], -20, "同一玩家多次甩牌失败应累积");
});

test("投票踢人：大厅清空座位，牌局中真人变为 AI 替补避免卡局", () => {
  const lobby = createRoom("KICKLOBBY");
  sit(lobby, "p0", 0, "A");
  sit(lobby, "p1", 1, "B");
  kickSeatByVote(lobby, 1);
  assert.equal(lobby.seats[1].playerId, null);

  const playing = createRoom("KICKPLAY");
  for (let i = 0; i < 5; i += 1) sit(playing, `q${i}`, i, `Q${i}`);
  startRound(playing, () => 0.1);
  playing.phase = "playing";
  kickSeatByVote(playing, 2);
  assert.equal(playing.seats[2].isAi, true);
  assert.match(playing.seats[2].nickname, /AI替补3/);
});

test("观众可接管 AI 座位，保留 AI 手牌和牌局状态继续打", () => {
  const room = createRoom("TAKEAI");
  const deck = createDeck();
  for (let i = 0; i < 5; i += 1) {
    if (i === 2) addAiPlayer(room, i, "medium");
    else sit(room, `p${i}`, i, `P${i}`);
  }
  room.phase = "playing";
  room.turnSeat = 2;
  room.currentLeader = 2;
  room.levelRank = "2";
  room.trumpSuit = "hearts";
  const aiHand = deck.slice(0, 5);
  room.seats[2].hand = [...aiHand];
  room.seats[2].takenTrickPoints = 25;
  room.spectators.set("newbie", { playerId: "newbie", nickname: "新玩家", connected: true });

  takeoverAiSeat(room, "newbie", 2, "新玩家", "😀");
  assert.equal(room.seats[2].isAi, false);
  assert.equal(room.seats[2].playerId, "newbie");
  assert.deepEqual(room.seats[2].hand.map((c) => c.id), aiHand.map((c) => c.id));
  assert.equal(room.seats[2].takenTrickPoints, 25);
  assert.equal(room.turnSeat, 2);
  assert.equal(publicState(room, "newbie").seats[2].hand.length, 5);
});

test("发牌中亮主后，发完牌需重新等待其他玩家不抢", () => {
  const room = createRoom("DEALBID");
  for (let i = 0; i < 5; i += 1) { const s = room.seats[i]; s.playerId = `p${i}`; s.nickname = `P${i}`; }
  startRound(room, () => 0.1, { deal: false });

  let bidder = null;
  let bidCard = null;
  while (room.dealing && !bidder) {
    dealRound(room);
    for (const seat of room.seats) {
      const card = seat.hand.find((c) => c.rank === seat.level && c.suit !== "joker");
      if (card) { bidder = seat; bidCard = card; break; }
    }
  }
  assert.ok(bidder && bidCard, "测试需要在发牌阶段找到可亮主牌");

  makeBid(room, bidder.playerId, [bidCard.id]);
  for (const seat of room.seats) {
    if (seat.index !== bidder.index) passBid(room, seat.playerId);
  }
  assert.equal(room.dealing, true);

  while (dealRound(room)) { /* finish deal */ }
  assert.equal(room.phase, "auctionReady", "发完牌后不能沿用发牌中的不抢直接确认");
  assert.deepEqual(room.bidResponses, { [bidder.index]: "bid" });
  assert.equal(room.dealerSeat, bidder.index);

  for (const seat of room.seats) {
    if (seat.index !== bidder.index) passBid(room, seat.playerId);
  }
  assert.equal(room.phase, "burying");
});

test("发牌阶段有人亮主后，未确认庄前继续按本人等级理牌", () => {
  const room = createRoom("DEALSORT");
  const deck = createDeck();
  const card = (rank, suit, copy = 1) => deck.find((c) => c.rank === rank && c.suit === suit && c.copy === copy);
  for (let i = 0; i < 5; i += 1) {
    const s = room.seats[i];
    s.playerId = `p${i}`;
    s.nickname = `P${i}`;
    s.level = i === 0 ? "4" : "A";
  }
  room.phase = "dealing";
  room.dealing = true;
  room.dealCursor = 0;
  room.kittySize = 0;
  room.firstLevel = "A";
  room.seats[0].hand = [card("4", "hearts", 1)];
  room.seats[1].hand = [card("A", "spades", 1), card("4", "clubs", 1)];

  makeBid(room, "p0", [card("4", "hearts", 1).id]);
  room.deck = [
    card("6", "spades", 1), card("7", "hearts", 1), card("8", "clubs", 1), card("9", "diamonds", 1), card("10", "spades", 1)
  ];
  dealRound(room);

  assert.equal(room.seats[1].hand[0].rank, "A", "庄家未确认前，别人的 A 仍应按本人等级排在常主区");
});

test("跟超长副牌拖拉机时同门牌极多也不返回非法牌", () => {
  const room = createRoom("LONGTR");
  room.levelRank = "2"; room.trumpSuit = "spades"; room.dealerSeat = 0; room.friendSeat = null;
  const deck = createDeck();
  const cardsOf = (rank, suit, n = 2) => deck.filter((c) => c.rank === rank && c.suit === suit).slice(0, n);
  // 敌家领出 clubs 四连对 4455 6677（避开级牌 2 与主 spades）
  const lead = [...cardsOf("4", "clubs"), ...cardsOf("5", "clubs"), ...cardsOf("6", "clubs"), ...cardsOf("7", "clubs")];
  assert.equal(analyzeShape(lead, room).type, "tractor");
  room.seats[0].playerId = "e0";
  const ai = room.seats[1];
  ai.playerId = "ai1"; ai.isAi = true; ai.aiLevel = "medium";
  // 跟家 clubs 极多（A~10 多条三条/对子可拼成 >8 张长拖拉机，但无“恰好 8 张”的简单候选），
  // 迫使 findAnyLegalCombination 组合爆炸超上限 → 必须靠结构化兜底给出合法牌。
  // 无 K：最大对子 A 孤立（与 Q 间断开），故“取最大几个对子”拼不出合法拖拉机；
  // 合法四连对只在 Q-J-10-9-8 段里，且 3/6 干扰单张迫使穷举深入直至超限。
  ai.hand = [
    ...cardsOf("A", "clubs", 3), ...cardsOf("Q", "clubs", 3), ...cardsOf("J", "clubs", 3),
    ...cardsOf("10", "clubs", 3), ...cardsOf("9", "clubs", 3), ...cardsOf("8", "clubs", 2),
    ...cardsOf("6", "clubs", 3), ...cardsOf("3", "clubs", 3)
  ];
  room.currentTrick = [{ seat: 0, cards: lead, shape: analyzeShape(lead, room), points: 0 }];
  room.turnSeat = 1;
  const play = chooseAiPlay(room, ai, lead);
  assert.equal(play.length, 8, "必须跟满 8 张");
  assert.equal(validatePlay(room, ai, play, lead).ok, true, "兜底也必须是合法跟牌");
});

test("昵称去空白并按字符限长", () => {
  const room = createRoom("NICK");
  sit(room, "p1", 0, "  " + "字".repeat(100) + "  ", null);
  assert.equal([...room.seats[0].nickname].length, 16, "昵称应被限制为 16 个字符");
  sit(room, "p2", 1, "   ", null);
  assert.equal(room.seats[1].nickname, "玩家2", "纯空白昵称回退到默认名");
});

test("confirmDealer 幂等：重复确认不会把底牌并入两次", () => {
  const room = createRoom("CONF");
  const deck = createDeck();
  for (let i = 0; i < 5; i += 1) { const s = room.seats[i]; s.playerId = `p${i}`; s.nickname = `P${i}`; s.level = "2"; }
  room.kitty = deck.slice(0, 7);
  room.seats.forEach((s, i) => { s.hand = deck.slice(7 + i * 5, 12 + i * 5); });
  room.dealerSeat = 0;
  room.currentBid = { seat: 0, levelRank: "2", trumpSuit: "hearts", noTrump: false };
  room.phase = "auction"; room.dealing = false;
  const before = room.seats[0].hand.length;
  confirmDealer(room);
  assert.equal(room.seats[0].hand.length, before + 7, "首次确认并入 7 张底牌");
  assert.equal(room.phase, "burying");
  confirmDealer(room); // 重复确认应早退
  assert.equal(room.seats[0].hand.length, before + 7, "重复确认不应再次并入底牌");
});

test("朋友现身时设置 friendReveal 供前端动画", () => {
  const room = createRoom("FRV");
  room.levelRank = "2"; room.trumpSuit = "hearts";
  room.phase = "playing"; room.dealerSeat = 0; room.friendSeat = null;
  room.friendCall = { rank: "A", suit: "spades", ordinal: 1, seen: 0 };
  const deck = createDeck();
  const spadeA = deck.find((c) => c.rank === "A" && c.suit === "spades");
  for (let i = 0; i < 5; i += 1) { const s = room.seats[i]; s.playerId = `p${i}`; s.nickname = `P${i}`; }
  room.seats[1].hand = [spadeA, deck.find((c) => c.rank === "3" && c.suit === "spades")];
  room.turnSeat = 1;
  playCards(room, "p1", [spadeA.id]); // 领出黑桃A → 匹配朋友牌 → 现身
  assert.equal(room.friendSeat, 1);
  assert.ok(room.friendReveal && room.friendReveal.seat === 1 && room.friendReveal.seq >= 1);
});

test("6 人房间：配置正确、发牌 26 张底 6 张、扣底跳过叫朋友直接开打", () => {
  const room = createRoom("SIX", { seatCount: 6 });
  assert.equal(room.seatCount, 6);
  assert.equal(room.kittySize, 6);
  assert.equal(room.fixedTeams, true);
  assert.equal(room.seats.length, 6);
  for (let i = 0; i < 6; i += 1) { const s = room.seats[i]; s.playerId = `p${i}`; s.nickname = `P${i}`; }
  startRound(room, () => 0.3);
  assert.deepEqual(room.seats.map((s) => s.hand.length), [26, 26, 26, 26, 26, 26]);
  assert.equal(room.kitty.length, 6);
  // 走到扣底：庄家扣 6 张后，6 人应跳过叫朋友直接进入出牌
  room.phase = "burying"; room.dealerSeat = 0; room.levelRank = "2"; room.trumpSuit = "hearts";
  const bury = room.seats[0].hand.slice(0, 6).map((c) => c.id);
  buryKitty(room, "p0", bury);
  assert.equal(room.phase, "playing", "6 人扣底后跳过叫朋友直接开打");
  assert.equal(room.friendSeat, null);
});

function createPlayRuleRoom(code, seatCount = 5, options = {}) {
  const room = createRoom(`${code}${seatCount}`, seatCount === 6 ? { seatCount: 6 } : {});
  room.phase = "playing";
  room.levelRank = options.levelRank || "2";
  room.trumpSuit = options.trumpSuit || "hearts";
  room.noTrump = false;
  room.dealerSeat = 0;
  room.friendSeat = null;
  if (seatCount === 6) room.teamLevels = { 0: room.levelRank, 1: room.levelRank };
  room.currentLeader = 0;
  room.turnSeat = 0;
  for (let i = 0; i < seatCount; i += 1) {
    const seat = room.seats[i];
    seat.playerId = `p${i}`;
    seat.nickname = `P${i}`;
    seat.level = room.levelRank;
  }
  return room;
}

for (const seatCount of [5, 6]) {
  test(`${seatCount} 人出牌一致性：甩牌全单张时对子不能压单张`, () => {
    const room = createPlayRuleRoom("PARITYSINGLE", seatCount);
    const deck = createDeck();
    const lead = [
      deck.find((c) => c.rank === "A" && c.suit === "clubs"),
      deck.find((c) => c.rank === "K" && c.suit === "clubs")
    ];
    const pair10 = deck.filter((c) => c.rank === "10" && c.suit === "clubs").slice(0, 2);
    room.currentTrick = [
      { seat: 0, cards: lead, shape: analyzeShape(lead, room), points: 0 },
      { seat: 1, cards: pair10, shape: analyzeShape(pair10, room), points: 20 }
    ];

    assert.equal(analyzeShape(lead, room).type, "throw");
    assert.equal(determineTrickWinner(room, room.currentTrick), 0);
  });

  test(`${seatCount} 人出牌一致性：副牌两对甩牌可被主牌拖拉机按结构杀`, () => {
    const room = createPlayRuleRoom("PARITYCUTTRACTOR", seatCount, { levelRank: "7", trumpSuit: "clubs" });
    const deck = createDeck();
    const cardsOf = (rank, suit, n) => deck.filter((c) => c.rank === rank && c.suit === suit).slice(0, n);
    const lead = [...cardsOf("Q", "spades", 2), ...cardsOf("10", "spades", 2)];
    const cut = [...cardsOf("7", "clubs", 2), ...cardsOf("smallJoker", "joker", 2)];
    room.currentTrick = [
      { seat: 0, cards: lead, shape: analyzeShape(lead, room), points: 0 },
      { seat: 1, cards: cut, shape: analyzeShape(cut, room), points: 0 }
    ];

    assert.equal(analyzeShape(lead, room).type, "throw");
    assert.equal(analyzeShape(cut, room).type, "tractor");
    assert.equal(determineTrickWinner(room, room.currentTrick), 1);
  });

  test(`${seatCount} 人出牌一致性：跟拖拉机时必须优先出拖拉机`, () => {
    const room = createPlayRuleRoom("PARITYTRACTORFOLLOW", seatCount, { levelRank: "2", trumpSuit: "hearts" });
    const deck = createDeck();
    const cardsOf = (rank, suit, n) => deck.filter((c) => c.rank === rank && c.suit === suit).slice(0, n);
    const lead = [...cardsOf("7", "clubs", 2), ...cardsOf("8", "clubs", 2)];
    const illegal = [...cardsOf("A", "clubs", 2), ...cardsOf("4", "clubs", 2)];
    const legal = [...cardsOf("9", "clubs", 2), ...cardsOf("10", "clubs", 2)];
    const follower = room.seats[1];
    follower.hand = [...illegal, ...legal];
    follower.lockedTriples = [];
    room.currentTrick = [{ seat: 0, cards: lead, shape: analyzeShape(lead, room), points: 0 }];

    assert.equal(analyzeShape(lead, room).type, "tractor");
    assert.equal(validatePlay(room, follower, illegal, lead).ok, false);
    assert.equal(validatePlay(room, follower, legal, lead).ok, true);
  });

  test(`${seatCount} 人出牌一致性：三条锁定后两张同点可按两张单牌出`, () => {
    const room = createPlayRuleRoom("PARITYLOCK", seatCount, { levelRank: "7", trumpSuit: "hearts" });
    const deck = createDeck();
    const bigJokers = deck.filter((c) => c.rank === "bigJoker").slice(0, 2);
    const locked8 = deck.filter((c) => c.rank === "8" && c.suit === "hearts").slice(0, 2);
    const follower = room.seats[1];
    follower.hand = [...locked8, deck.find((c) => c.rank === "A" && c.suit === "hearts")];
    follower.lockedTriples = ["8|hearts"];
    room.currentTrick = [{ seat: 0, cards: bigJokers, shape: analyzeShape(bigJokers, room), points: 0 }];

    assert.equal(validatePlay(room, follower, locked8, bigJokers).ok, true);
    assert.equal(validatePlay(room, follower, locked8, null).ok, false);
  });

  test(`${seatCount} 人出牌一致性：主牌杀副牌只在首家副牌时标记杀`, () => {
    const room = createPlayRuleRoom("PARITYKILLMARK", seatCount, { levelRank: "2", trumpSuit: "hearts" });
    const deck = createDeck();
    const lead = deck.find((c) => c.rank === "A" && c.suit === "spades");
    const cut = deck.find((c) => c.rank === "3" && c.suit === "hearts");
    room.currentTrick = [
      { seat: 0, cards: [lead], shape: analyzeShape([lead], room), points: 0 },
      { seat: 1, cards: [cut], shape: analyzeShape([cut], room), points: 0 }
    ];

    assert.deepEqual(publicState(room, "p0").trumpKillSeats, [1]);

    const trumpLead = deck.find((c) => c.rank === "A" && c.suit === "hearts");
    const trumpFollow = deck.find((c) => c.rank === "K" && c.suit === "hearts");
    room.currentTrick = [
      { seat: 0, cards: [trumpLead], shape: analyzeShape([trumpLead], room), points: 0 },
      { seat: 1, cards: [trumpFollow], shape: analyzeShape([trumpFollow], room), points: 0 }
    ];
    assert.deepEqual(publicState(room, "p0").trumpKillSeats, []);
  });

  test(`${seatCount} 人出牌一致性：最后一轮首家出完后自动出完整墩`, () => {
    const room = createPlayRuleRoom("PARITYAUTOLAST", seatCount, { levelRank: "2", trumpSuit: "hearts" });
    const deck = createDeck();
    const ranks = ["A", "K", "Q", "J", "10", "9"];
    const cards = Array.from({ length: seatCount }, (_, i) => deck.find((c) => c.rank === ranks[i] && c.suit === "spades"));
    for (let i = 0; i < seatCount; i += 1) room.seats[i].hand = [cards[i]];

    playCards(room, "p0", [cards[0].id]);

    assert.equal(room.phase, "roundOver");
    assert.deepEqual(room.lastTrick.map((play) => play.seat), Array.from({ length: seatCount }, (_, i) => i));
    assert.deepEqual(room.seats.map((seat) => seat.hand.length), Array.from({ length: seatCount }, () => 0));
  });
}

test("甩牌主牌杀：三条+相邻对子不被误当拖拉机（结构匹配正确）", () => {
  const room = createRoom("THROW");
  room.levelRank = "2"; room.trumpSuit = "hearts";
  const deck = createDeck();
  const cardsOf = (rank, suit, n) => deck.filter((c) => c.rank === rank && c.suit === suit).slice(0, n);
  // 闲家甩 梅花 AAA+QQ（三条+对子，A/Q 不相邻 → triple+pair）
  const lead = [...cardsOf("A", "clubs", 3), ...cardsOf("Q", "clubs", 2)];
  // 下家用主牌 红桃 333+44 杀（三条+对子，3/4 在主牌里相邻，但张数不等不构成拖拉机）
  const cut = [...cardsOf("3", "hearts", 3), ...cardsOf("4", "hearts", 2)];
  room.currentTrick = [
    { seat: 0, cards: lead, shape: analyzeShape(lead, room), points: 0 },
    { seat: 1, cards: cut, shape: analyzeShape(cut, room), points: 0 }
  ];
  // 双方都是“三条+对子”，结构匹配，主牌杀应成功（赢家=seat1）
  assert.equal(determineTrickWinner(room, room.currentTrick), 1);
});

test("甩牌全是单张时，后手对子不能按对子层级压过单张", () => {
  const room = createRoom("THROWSINGLE");
  room.levelRank = "2"; room.trumpSuit = "hearts";
  const deck = createDeck();
  const lead = [
    deck.find((c) => c.rank === "A" && c.suit === "clubs"),
    deck.find((c) => c.rank === "K" && c.suit === "clubs")
  ];
  const pair10 = deck.filter((c) => c.rank === "10" && c.suit === "clubs").slice(0, 2);
  room.currentTrick = [
    { seat: 0, cards: lead, shape: analyzeShape(lead, room), points: 0 },
    { seat: 1, cards: pair10, shape: analyzeShape(pair10, room), points: 20 }
  ];

  assert.equal(analyzeShape(lead, room).type, "throw");
  assert.equal(determineTrickWinner(room, room.currentTrick), 0);
});

test("甩牌最高组件是对子时，只比较对子大小", () => {
  const room = createRoom("THROWPAIR");
  room.levelRank = "2"; room.trumpSuit = "hearts";
  const deck = createDeck();
  const cardsOf = (rank, suit, n) => deck.filter((c) => c.rank === rank && c.suit === suit).slice(0, n);
  const lead = [...cardsOf("9", "clubs", 2), cardsOf("A", "clubs", 1)[0], cardsOf("K", "clubs", 1)[0]];
  const follow = [...cardsOf("10", "clubs", 2), cardsOf("4", "clubs", 1)[0], cardsOf("3", "clubs", 1)[0]];
  room.currentTrick = [
    { seat: 0, cards: lead, shape: analyzeShape(lead, room), points: 0 },
    { seat: 1, cards: follow, shape: analyzeShape(follow, room), points: 20 }
  ];

  assert.equal(analyzeShape(lead, room).type, "throw");
  assert.equal(determineTrickWinner(room, room.currentTrick), 1);
});

test("副牌两对甩牌可被主牌拖拉机按两对结构杀", () => {
  const room = createRoom("THROWTRUMPPAIR");
  room.levelRank = "7"; room.trumpSuit = "clubs";
  const deck = createDeck();
  const cardsOf = (rank, suit, n) => deck.filter((c) => c.rank === rank && c.suit === suit).slice(0, n);
  const lead = [...cardsOf("Q", "spades", 2), ...cardsOf("10", "spades", 2)];
  const cut = [...cardsOf("7", "clubs", 2), ...cardsOf("smallJoker", "joker", 2)];
  room.currentTrick = [
    { seat: 0, cards: lead, shape: analyzeShape(lead, room), points: 0 },
    { seat: 1, cards: cut, shape: analyzeShape(cut, room), points: 0 }
  ];

  assert.equal(analyzeShape(lead, room).type, "throw");
  assert.equal(analyzeShape(cut, room).type, "tractor");
  assert.equal(determineTrickWinner(room, room.currentTrick), 1);
});

test("副牌两张单牌甩牌可被一对主牌按两张单牌杀", () => {
  const room = createRoom("THROWTRUMPSINGLES");
  room.levelRank = "7"; room.trumpSuit = "clubs";
  const deck = createDeck();
  const cardsOf = (rank, suit, n = 1) => deck.filter((c) => c.rank === rank && c.suit === suit).slice(0, n);
  const lead = [cardsOf("A", "spades", 1)[0], cardsOf("K", "spades", 1)[0]];
  const cut = cardsOf("3", "clubs", 2);
  room.currentTrick = [
    { seat: 0, cards: lead, shape: analyzeShape(lead, room), points: 0 },
    { seat: 1, cards: cut, shape: analyzeShape(cut, room), points: 0 }
  ];

  assert.equal(analyzeShape(lead, room).type, "throw");
  assert.equal(analyzeShape(cut, room).type, "pair");
  assert.equal(determineTrickWinner(room, room.currentTrick), 1);
});

test("副牌一对加单张甩牌可被三条主牌按对子加单张杀", () => {
  const room = createRoom("THROWTRUMPTRIPLE");
  room.levelRank = "7"; room.trumpSuit = "clubs";
  const deck = createDeck();
  const cardsOf = (rank, suit, n = 1) => deck.filter((c) => c.rank === rank && c.suit === suit).slice(0, n);
  const lead = [...cardsOf("Q", "spades", 2), cardsOf("A", "spades", 1)[0]];
  const cut = cardsOf("9", "clubs", 3);
  room.currentTrick = [
    { seat: 0, cards: lead, shape: analyzeShape(lead, room), points: 0 },
    { seat: 1, cards: cut, shape: analyzeShape(cut, room), points: 0 }
  ];

  assert.equal(analyzeShape(lead, room).type, "throw");
  assert.equal(analyzeShape(cut, room).type, "triple");
  assert.equal(determineTrickWinner(room, room.currentTrick), 1);
});

test("甩牌含三条时，主牌对子不能顶替三条结构", () => {
  const room = createRoom("THROWTRIPLENOCUT");
  room.levelRank = "7"; room.trumpSuit = "clubs";
  const deck = createDeck();
  const cardsOf = (rank, suit, n = 1) => deck.filter((c) => c.rank === rank && c.suit === suit).slice(0, n);
  const lead = [...cardsOf("Q", "spades", 3), cardsOf("A", "spades", 1)[0]];
  const cut = [...cardsOf("9", "clubs", 2), ...cardsOf("8", "clubs", 2)];
  room.currentTrick = [
    { seat: 0, cards: lead, shape: analyzeShape(lead, room), points: 0 },
    { seat: 1, cards: cut, shape: analyzeShape(cut, room), points: 0 }
  ];

  assert.equal(analyzeShape(lead, room).type, "throw");
  assert.equal(determineTrickWinner(room, room.currentTrick), 0);
});

test("跟拖拉机时手里有拖拉机必须优先出拖拉机，不能用散对子代替", () => {
  const room = createRoom("TRFOLLOW");
  room.levelRank = "2"; room.trumpSuit = "hearts";
  const deck = createDeck();
  const cardsOf = (rank, suit, n = 2) => deck.filter((c) => c.rank === rank && c.suit === suit).slice(0, n);
  const lead = [...cardsOf("8", "clubs"), ...cardsOf("7", "clubs")];
  const legal = [...cardsOf("10", "clubs"), ...cardsOf("9", "clubs")];
  const illegal = [...cardsOf("9", "clubs"), ...cardsOf("4", "clubs")];
  const follower = room.seats[1];
  follower.playerId = "p1";
  follower.lockedTriples = [];
  follower.hand = [...legal, ...cardsOf("4", "clubs")];

  assert.equal(analyzeShape(lead, room).type, "tractor");
  assert.equal(analyzeShape(legal, room).type, "tractor");
  assert.equal(validatePlay(room, follower, illegal, lead).ok, false);
  assert.equal(validatePlay(room, follower, legal, lead).ok, true);
});

test("手里有长拖拉机时，跟短拖拉机可选择任意连续短段", () => {
  const room = createRoom("TRSLICE");
  room.levelRank = "2"; room.trumpSuit = "hearts";
  const deck = createDeck();
  const cardsOf = (rank, suit, n = 2) => deck.filter((c) => c.rank === rank && c.suit === suit).slice(0, n);
  const lead = [...cardsOf("4", "clubs"), ...cardsOf("3", "clubs")];
  const lowSlice = [...cardsOf("6", "clubs"), ...cardsOf("5", "clubs")];
  const highSlice = [...cardsOf("7", "clubs"), ...cardsOf("6", "clubs")];
  const brokenPairs = [...cardsOf("7", "clubs"), ...cardsOf("5", "clubs")];
  const follower = room.seats[1];
  follower.playerId = "p1";
  follower.lockedTriples = [];
  follower.hand = [...cardsOf("7", "clubs"), ...cardsOf("6", "clubs"), ...cardsOf("5", "clubs")];

  assert.equal(analyzeShape(lowSlice, room).type, "tractor");
  assert.equal(analyzeShape(highSlice, room).type, "tractor");
  assert.equal(validatePlay(room, follower, lowSlice, lead).ok, true);
  assert.equal(validatePlay(room, follower, highSlice, lead).ok, true);
  assert.equal(validatePlay(room, follower, brokenPairs, lead).ok, false);
});

test("跟三连对拖拉机时，三条不算强制对子，可选择不拆三条", () => {
  const room = createRoom("TRPAIRTRIPLE");
  room.levelRank = "7"; room.trumpSuit = "clubs";
  const deck = createDeck();
  const cardsOf = (rank, suit, n = 1) => deck.filter((c) => c.rank === rank && c.suit === suit).slice(0, n);
  const lead = [...cardsOf("A", "clubs", 2), ...cardsOf("K", "clubs", 2), ...cardsOf("Q", "clubs", 2)];
  const naturalPair = cardsOf("10", "clubs", 2);
  const triple = cardsOf("9", "clubs", 3);
  const singles = ["8", "6", "5", "4"].map((rank) => cardsOf(rank, "clubs", 1)[0]);
  const follower = room.seats[1];
  follower.playerId = "p1";
  follower.lockedTriples = [];
  follower.hand = [...naturalPair, ...triple, ...singles];
  const keepTriple = [...naturalPair, triple[0], ...singles.slice(0, 3)];
  const skipNaturalPair = [naturalPair[0], triple[0], ...singles];

  assert.equal(analyzeShape(lead, room).type, "tractor");
  assert.equal(analyzeShape(lead, room).unit, 2);
  assert.equal(analyzeShape(lead, room).count, 3);
  assert.equal(validatePlay(room, follower, keepTriple, lead).ok, true);
  assert.equal(validatePlay(room, follower, skipNaturalPair, lead).ok, false);
});

test("跟两连对拖拉机时，可用天然对子加单张保留三条，也可自愿拆三条", () => {
  const room = createRoom("TRPAIRKEEPTRIPLE");
  room.levelRank = "7"; room.trumpSuit = "clubs";
  const deck = createDeck();
  const cardsOf = (rank, suit, n = 1) => deck.filter((c) => c.rank === rank && c.suit === suit).slice(0, n);
  const lead = [...cardsOf("A", "clubs", 2), ...cardsOf("K", "clubs", 2)];
  const naturalPair = cardsOf("5", "clubs", 2);
  const triple = cardsOf("4", "clubs", 3);
  const single = cardsOf("3", "clubs", 1)[0];
  const follower = room.seats[1];
  follower.playerId = "p1";
  follower.lockedTriples = [];
  follower.hand = [...naturalPair, ...triple, single];
  const keepTriple = [...naturalPair, triple[0], single];
  const splitTriple = [...naturalPair, triple[0], triple[1]];

  assert.equal(analyzeShape(lead, room).type, "tractor");
  assert.equal(validatePlay(room, follower, keepTriple, lead).ok, true);
  assert.equal(validatePlay(room, follower, splitTriple, lead).ok, true);
});

test("需要对子但只有三条时，不拆出单张会锁定三条，之后不能拆成对子领出", () => {
  const room = createRoom("TRLOCKPAIR");
  room.levelRank = "2"; room.trumpSuit = "hearts";
  room.phase = "playing";
  const deck = createDeck();
  const cardsOf = (rank, suit, n = 1) => deck.filter((c) => c.rank === rank && c.suit === suit).slice(0, n);
  const lead = cardsOf("A", "clubs", 2);
  const triple = cardsOf("9", "clubs", 3);
  const singles = [cardsOf("6", "clubs", 1)[0], cardsOf("5", "clubs", 1)[0]];
  const follower = room.seats[1];
  room.seats[0].playerId = "p0";
  follower.playerId = "p1";
  follower.lockedTriples = [];
  follower.hand = [...triple, ...singles];
  room.currentTrick = [{ seat: 0, cards: lead, shape: analyzeShape(lead, room), points: 0 }];
  room.currentLeader = 0;
  room.turnSeat = 1;

  assert.equal(validatePlay(room, follower, singles, lead).ok, true, "没有天然对子时，可选择不拆三条出两张单牌");
  playCards(room, "p1", singles.map((c) => c.id));
  assert.deepEqual(follower.lockedTriples, ["9|clubs"]);
  assert.equal(validatePlay(room, follower, triple.slice(0, 2), null).ok, false, "锁定后三条不能再拆成对子领出");
  assert.equal(validatePlay(room, follower, triple, null).ok, true, "锁定后三条仍可整组三张出");
});

test("拖拉机跟牌时天然对子足够，剩下三条之后仍可选择拆成对子", () => {
  const room = createRoom("TRLOCKNATURAL");
  room.levelRank = "2"; room.trumpSuit = "hearts";
  room.phase = "playing";
  const deck = createDeck();
  const cardsOf = (rank, suit, n = 1) => deck.filter((c) => c.rank === rank && c.suit === suit).slice(0, n);
  const lead = [...cardsOf("A", "clubs", 2), ...cardsOf("K", "clubs", 2)];
  const pair1 = cardsOf("8", "clubs", 2);
  const pair2 = cardsOf("7", "clubs", 2);
  const triple = cardsOf("6", "clubs", 3);
  const follower = room.seats[1];
  room.seats[0].playerId = "p0";
  follower.playerId = "p1";
  follower.lockedTriples = [];
  follower.hand = [...pair1, ...pair2, ...triple];
  room.currentTrick = [{ seat: 0, cards: lead, shape: analyzeShape(lead, room), points: 0 }];
  room.currentLeader = 0;
  room.turnSeat = 1;

  const naturalFollow = [...pair1, ...pair2];
  assert.equal(validatePlay(room, follower, naturalFollow, lead).ok, true);
  playCards(room, "p1", naturalFollow.map((c) => c.id));
  assert.deepEqual(follower.lockedTriples, [], "天然对子足够时，三条没有参与选择，不锁");
  assert.equal(validatePlay(room, follower, triple.slice(0, 2), null).ok, true, "剩下三条之后仍可选择拆成对子");
});

test("跟三条时手里有三条必须优先出三条", () => {
  const room = createRoom("TRIPLEFOLLOW");
  room.levelRank = "2"; room.trumpSuit = "hearts";
  const deck = createDeck();
  const cardsOf = (rank, suit, n = 3) => deck.filter((c) => c.rank === rank && c.suit === suit).slice(0, n);
  const lead = cardsOf("4", "clubs", 3);
  const legal = cardsOf("7", "clubs", 3);
  const illegal = [...cardsOf("7", "clubs", 2), cardsOf("5", "clubs", 1)[0]];
  const follower = room.seats[1];
  follower.playerId = "p1";
  follower.lockedTriples = [];
  follower.hand = [...cardsOf("7", "clubs", 3), cardsOf("5", "clubs", 1)[0]];

  assert.equal(validatePlay(room, follower, illegal, lead).ok, false);
  assert.equal(validatePlay(room, follower, legal, lead).ok, true);
});

test("跟三条拖拉机时，有三条拖拉机必须优先出三条拖拉机", () => {
  const room = createRoom("TRITR1");
  room.levelRank = "2"; room.trumpSuit = "hearts";
  const deck = createDeck();
  const cardsOf = (rank, suit, n = 3) => deck.filter((c) => c.rank === rank && c.suit === suit).slice(0, n);
  const lead = [...cardsOf("4", "clubs"), ...cardsOf("3", "clubs")];
  const legal = [...cardsOf("8", "clubs"), ...cardsOf("7", "clubs")];
  const illegal = [...cardsOf("8", "clubs"), ...cardsOf("5", "clubs")];
  const follower = room.seats[1];
  follower.playerId = "p1"; follower.lockedTriples = [];
  follower.hand = [...legal, ...cardsOf("5", "clubs")];

  assert.equal(analyzeShape(lead, room).type, "tractor");
  assert.equal(analyzeShape(lead, room).unit, 3);
  assert.equal(validatePlay(room, follower, illegal, lead).ok, false);
  assert.equal(validatePlay(room, follower, legal, lead).ok, true);
});

test("跟三条拖拉机时，只有一组三条则必须出三条并尽量补对子", () => {
  const room = createRoom("TRITR2");
  room.levelRank = "2"; room.trumpSuit = "hearts";
  const deck = createDeck();
  const cardsOf = (rank, suit, n = 3) => deck.filter((c) => c.rank === rank && c.suit === suit).slice(0, n);
  const lead = [...cardsOf("4", "clubs"), ...cardsOf("3", "clubs")];
  const legal = [...cardsOf("8", "clubs"), ...cardsOf("6", "clubs", 2), cardsOf("5", "clubs", 1)[0]];
  const illegal = [...cardsOf("8", "clubs"), cardsOf("6", "clubs", 1)[0], cardsOf("5", "clubs", 1)[0], cardsOf("J", "clubs", 1)[0]];
  const follower = room.seats[1];
  follower.playerId = "p1"; follower.lockedTriples = [];
  follower.hand = [...cardsOf("8", "clubs"), ...cardsOf("6", "clubs", 2), cardsOf("5", "clubs", 1)[0], cardsOf("J", "clubs", 1)[0]];

  assert.equal(validatePlay(room, follower, illegal, lead).ok, false);
  assert.equal(validatePlay(room, follower, legal, lead).ok, true);
});

test("跟三条拖拉机时，没有三条但有三连对子拖拉机必须出三连对子", () => {
  const room = createRoom("TRITR3");
  room.levelRank = "2"; room.trumpSuit = "hearts";
  const deck = createDeck();
  const cardsOf = (rank, suit, n = 2) => deck.filter((c) => c.rank === rank && c.suit === suit).slice(0, n);
  const lead = [...cardsOf("4", "clubs", 3), ...cardsOf("3", "clubs", 3)];
  const legal = [...cardsOf("9", "clubs"), ...cardsOf("8", "clubs"), ...cardsOf("7", "clubs")];
  const illegal = [...cardsOf("9", "clubs"), ...cardsOf("8", "clubs"), ...cardsOf("5", "clubs")];
  const follower = room.seats[1];
  follower.playerId = "p1"; follower.lockedTriples = [];
  follower.hand = [...legal, ...cardsOf("5", "clubs")];

  assert.equal(validatePlay(room, follower, illegal, lead).ok, false);
  assert.equal(validatePlay(room, follower, legal, lead).ok, true);
});

test("跟三条拖拉机时，只有二连对子拖拉机则必须出拖拉机并补一对", () => {
  const room = createRoom("TRITR4");
  room.levelRank = "2"; room.trumpSuit = "hearts";
  const deck = createDeck();
  const cardsOf = (rank, suit, n = 2) => deck.filter((c) => c.rank === rank && c.suit === suit).slice(0, n);
  const lead = [...cardsOf("4", "clubs", 3), ...cardsOf("3", "clubs", 3)];
  const legal = [...cardsOf("Q", "clubs"), ...cardsOf("J", "clubs"), ...cardsOf("6", "clubs")];
  const illegal = [...cardsOf("Q", "clubs"), ...cardsOf("8", "clubs"), ...cardsOf("6", "clubs")];
  const follower = room.seats[1];
  follower.playerId = "p1"; follower.lockedTriples = [];
  follower.hand = [...cardsOf("Q", "clubs"), ...cardsOf("J", "clubs"), ...cardsOf("8", "clubs"), ...cardsOf("6", "clubs")];

  assert.equal(validatePlay(room, follower, illegal, lead).ok, false);
  assert.equal(validatePlay(room, follower, legal, lead).ok, true);
});

test("跟三组三条拖拉机且只能降级到对子时，奇数总张数要求四对", () => {
  const room = createRoom("TRITR5");
  room.levelRank = "2"; room.trumpSuit = "hearts";
  const deck = createDeck();
  const cardsOf = (rank, suit, n = 2) => deck.filter((c) => c.rank === rank && c.suit === suit).slice(0, n);
  const lead = [...cardsOf("5", "clubs", 3), ...cardsOf("4", "clubs", 3), ...cardsOf("3", "clubs", 3)];
  const legal = [...cardsOf("A", "clubs"), ...cardsOf("K", "clubs"), ...cardsOf("Q", "clubs"), ...cardsOf("J", "clubs"), cardsOf("6", "clubs", 1)[0]];
  const illegal = [...cardsOf("A", "clubs"), ...cardsOf("K", "clubs"), ...cardsOf("Q", "clubs"), cardsOf("J", "clubs", 1)[0], cardsOf("6", "clubs", 1)[0], cardsOf("7", "clubs", 1)[0], cardsOf("8", "clubs", 1)[0]];
  const follower = room.seats[1];
  follower.playerId = "p1"; follower.lockedTriples = [];
  follower.hand = [...cardsOf("A", "clubs"), ...cardsOf("K", "clubs"), ...cardsOf("Q", "clubs"), ...cardsOf("J", "clubs"), cardsOf("6", "clubs", 1)[0], cardsOf("7", "clubs", 1)[0], cardsOf("8", "clubs", 1)[0]];

  assert.equal(validatePlay(room, follower, illegal, lead).ok, false);
  assert.equal(validatePlay(room, follower, legal, lead).ok, true);
});

test("跟甩牌里的拖拉机组件时，有拖拉机必须优先跟拖拉机", () => {
  const room = createRoom("THROWFOLLOW");
  room.levelRank = "2"; room.trumpSuit = "hearts";
  const deck = createDeck();
  const cardsOf = (rank, suit, n = 2) => deck.filter((c) => c.rank === rank && c.suit === suit).slice(0, n);
  const lead = [...cardsOf("A", "clubs"), ...cardsOf("8", "clubs"), ...cardsOf("7", "clubs")];
  const legal = [...cardsOf("10", "clubs"), ...cardsOf("9", "clubs"), ...cardsOf("4", "clubs")];
  const illegal = [...cardsOf("Q", "clubs"), ...cardsOf("9", "clubs"), ...cardsOf("4", "clubs")];
  const follower = room.seats[1];
  follower.playerId = "p1";
  follower.lockedTriples = [];
  follower.hand = [...cardsOf("Q", "clubs"), ...cardsOf("10", "clubs"), ...cardsOf("9", "clubs"), ...cardsOf("4", "clubs")];

  assert.equal(analyzeShape(lead, room).type, "throw");
  assert.equal(validatePlay(room, follower, illegal, lead).ok, false);
  assert.equal(validatePlay(room, follower, legal, lead).ok, true);
});

test("跟对子加单张甩牌时，只有三条不强制拆对子", () => {
  const room = createRoom("THROWTRIPLE");
  room.levelRank = "4"; room.trumpSuit = "hearts";
  const deck = createDeck();
  const cardsOf = (rank, suit, n = 1) => deck.filter((c) => c.rank === rank && c.suit === suit).slice(0, n);
  const lead = [...cardsOf("A", "clubs", 2), ...cardsOf("K", "clubs", 1)];
  const triple2 = cardsOf("2", "clubs", 3);
  const singles = ["3", "5", "6"].map((rank) => cardsOf(rank, "clubs", 1)[0]);
  const follower = room.seats[1];
  follower.playerId = "p1";
  follower.lockedTriples = [];
  follower.hand = [...triple2, ...singles];

  assert.equal(analyzeShape(lead, room).type, "throw");
  assert.equal(validatePlay(room, follower, singles, lead).ok, true);
  assert.equal(validatePlay(room, follower, [triple2[0], ...singles.slice(0, 2)], lead).ok, true);
});

function trumpTwoTripleThrowSetup(handCards) {
  const room = createRoom("TRUMP2TRI");
  room.levelRank = "2"; room.trumpSuit = "hearts";
  const deck = createDeck();
  const cardsOf = (rank, n = 1) => deck.filter((c) => c.rank === rank && c.suit === "hearts").slice(0, n);
  const lead = [...cardsOf("A", 3), ...cardsOf("9", 3)]; // 两组三条，不相邻，属于甩牌而非三条拖拉机
  const follower = room.seats[1];
  follower.playerId = "p1";
  follower.lockedTriples = [];
  follower.hand = handCards(cardsOf);
  assert.equal(analyzeShape(lead, room).type, "throw");
  return { room, follower, lead, cardsOf };
}

test("主牌甩两个三条：手里三个单独对子时，必须至少跟两个对子", () => {
  const { room, follower, lead, cardsOf } = trumpTwoTripleThrowSetup((c) => [
    ...c("K", 2), ...c("J", 2), ...c("7", 2), c("5")[0], c("4")[0], c("3")[0]
  ]);
  const legal = [...cardsOf("K", 2), ...cardsOf("J", 2), cardsOf("5")[0], cardsOf("4")[0]];
  const illegal = [...cardsOf("K", 2), cardsOf("J")[0], cardsOf("7")[0], cardsOf("5")[0], cardsOf("4")[0]];

  assert.equal(validatePlay(room, follower, illegal, lead).ok, false);
  assert.equal(validatePlay(room, follower, legal, lead).ok, true);
});

test("主牌甩两个三条：手里一个对子加一个对子拖拉机时，对子拖拉机可作为对子来源", () => {
  const { room, follower, lead, cardsOf } = trumpTwoTripleThrowSetup((c) => [
    ...c("Q", 2), ...c("8", 2), ...c("7", 2), c("5")[0], c("4")[0], c("3")[0]
  ]);
  const legal = [...cardsOf("8", 2), ...cardsOf("7", 2), cardsOf("5")[0], cardsOf("4")[0]];
  const illegal = [...cardsOf("Q", 2), cardsOf("8")[0], cardsOf("7")[0], cardsOf("5")[0], cardsOf("4")[0]];

  assert.equal(validatePlay(room, follower, illegal, lead).ok, false);
  assert.equal(validatePlay(room, follower, legal, lead).ok, true);
});

test("主牌甩两个三条：手里六张对子拖拉机时，至少跟两个对子，整条拖拉机也合法", () => {
  const { room, follower, lead, cardsOf } = trumpTwoTripleThrowSetup((c) => [
    ...c("8", 2), ...c("7", 2), ...c("6", 2), c("5")[0], c("4")[0], c("3")[0]
  ]);
  const legalFullTractor = [...cardsOf("8", 2), ...cardsOf("7", 2), ...cardsOf("6", 2)];
  const legalTwoPairs = [...cardsOf("8", 2), ...cardsOf("7", 2), cardsOf("5")[0], cardsOf("4")[0]];
  const illegal = [...cardsOf("8", 2), cardsOf("7")[0], cardsOf("6")[0], cardsOf("5")[0], cardsOf("4")[0]];

  assert.equal(validatePlay(room, follower, illegal, lead).ok, false);
  assert.equal(validatePlay(room, follower, legalTwoPairs, lead).ok, true);
  assert.equal(validatePlay(room, follower, legalFullTractor, lead).ok, true);
});

test("主牌甩两个三条：手里有三条拖拉机时，必须跟出两个三条", () => {
  const { room, follower, lead, cardsOf } = trumpTwoTripleThrowSetup((c) => [
    ...c("8", 3), ...c("7", 3), c("5")[0], c("4")[0], c("3")[0]
  ]);
  const legal = [...cardsOf("8", 3), ...cardsOf("7", 3)];
  const illegal = [...cardsOf("8", 3), cardsOf("7")[0], cardsOf("5")[0], cardsOf("4")[0]];

  assert.equal(validatePlay(room, follower, illegal, lead).ok, false);
  assert.equal(validatePlay(room, follower, legal, lead).ok, true);
});

test("主牌甩两个三条：手里一组三条加一个对子拖拉机时，必须跟三条并补一个天然对子", () => {
  const { room, follower, lead, cardsOf } = trumpTwoTripleThrowSetup((c) => [
    ...c("8", 3), ...c("6", 2), ...c("5", 2), c("4")[0], c("3")[0]
  ]);
  const legal = [...cardsOf("8", 3), ...cardsOf("6", 2), cardsOf("4")[0]];
  const illegalNoPair = [...cardsOf("8", 3), cardsOf("6")[0], cardsOf("5")[0], cardsOf("4")[0]];
  const illegalNoTriple = [...cardsOf("6", 2), ...cardsOf("5", 2), cardsOf("8")[0], cardsOf("4")[0]];

  assert.equal(validatePlay(room, follower, illegalNoPair, lead).ok, false);
  assert.equal(validatePlay(room, follower, illegalNoTriple, lead).ok, false);
  assert.equal(validatePlay(room, follower, legal, lead).ok, true);
});

test("publicState 标记主牌杀副牌，仅在首家副牌时显示杀", () => {
  const room = createRoom("KILL");
  room.phase = "playing";
  room.levelRank = "2"; room.trumpSuit = "hearts";
  const deck = createDeck();
  for (let i = 0; i < 5; i += 1) { const s = room.seats[i]; s.playerId = `p${i}`; s.nickname = `P${i}`; }
  const lead = deck.find((c) => c.rank === "A" && c.suit === "spades");
  const cut = deck.find((c) => c.rank === "3" && c.suit === "hearts");
  room.currentTrick = [
    { seat: 0, cards: [lead], shape: analyzeShape([lead], room), points: 0 },
    { seat: 1, cards: [cut], shape: analyzeShape([cut], room), points: 0 }
  ];
  assert.deepEqual(publicState(room, "p0").trumpKillSeats, [1]);

  const trumpLead = deck.find((c) => c.rank === "A" && c.suit === "hearts");
  const trumpFollow = deck.find((c) => c.rank === "K" && c.suit === "hearts");
  room.currentTrick = [
    { seat: 0, cards: [trumpLead], shape: analyzeShape([trumpLead], room), points: 0 },
    { seat: 1, cards: [trumpFollow], shape: analyzeShape([trumpFollow], room), points: 0 }
  ];
  assert.deepEqual(publicState(room, "p0").trumpKillSeats, []);
});

test("多人主杀时 currentWinnerSeat 只标记最大的一家", () => {
  const room = createRoom("KILL2");
  room.phase = "playing";
  room.levelRank = "2"; room.trumpSuit = "hearts";
  const deck = createDeck();
  for (let i = 0; i < 5; i += 1) { const s = room.seats[i]; s.playerId = `p${i}`; s.nickname = `P${i}`; }
  const lead = deck.find((c) => c.rank === "A" && c.suit === "spades");
  const lowCut = deck.find((c) => c.rank === "3" && c.suit === "hearts");
  const highCut = deck.find((c) => c.rank === "K" && c.suit === "hearts");
  room.currentTrick = [
    { seat: 0, cards: [lead], shape: analyzeShape([lead], room), points: 0 },
    { seat: 1, cards: [lowCut], shape: analyzeShape([lowCut], room), points: 0 },
    { seat: 2, cards: [highCut], shape: analyzeShape([highCut], room), points: 0 }
  ];
  const state = publicState(room, "p0");
  assert.deepEqual(state.trumpKillSeats, [1, 2]);
  assert.equal(state.currentWinnerSeat, 2);
});

test("一墩结束后暂停约 0.6 秒展示，赢家不能立刻领出下一墩", () => {
  const room = createRoom("PAUSE");
  room.phase = "playing";
  room.levelRank = "2"; room.trumpSuit = "hearts";
  const deck = createDeck();
  for (let i = 0; i < 5; i += 1) { const s = room.seats[i]; s.playerId = `p${i}`; s.nickname = `P${i}`; }
  const cards = [
    deck.find((c) => c.rank === "A" && c.suit === "spades"),
    deck.find((c) => c.rank === "K" && c.suit === "spades"),
    deck.find((c) => c.rank === "Q" && c.suit === "spades"),
    deck.find((c) => c.rank === "J" && c.suit === "spades"),
    deck.find((c) => c.rank === "9" && c.suit === "spades")
  ];
  const nextLead = deck.find((c) => c.rank === "3" && c.suit === "clubs");
  room.seats[0].hand = [cards[0], nextLead];
  for (let i = 1; i < 5; i += 1) room.seats[i].hand = [cards[i]];
  room.currentLeader = 0;
  room.turnSeat = 0;

  const beforeFinish = Date.now();
  for (let i = 0; i < 5; i += 1) playCards(room, `p${i}`, [cards[i].id]);
  assert.equal(room.turnSeat, 0);
  assert.ok(room.trickPauseUntil > Date.now());
  assert.ok(room.trickPauseUntil - beforeFinish >= 550);
  assert.ok(room.trickPauseUntil - beforeFinish <= 800);
  assert.throws(() => playCards(room, "p0", [nextLead.id]), /上一墩展示中/);

  room.trickPauseUntil = Date.now() - 1;
  playCards(room, "p0", [nextLead.id]);
  assert.equal(room.currentTrick.length, 1);
});

test("最后一轮首家出完后，后续玩家自动按顺序出牌", () => {
  const room = createRoom("AUTOLAST");
  room.phase = "playing";
  room.levelRank = "2"; room.trumpSuit = "hearts";
  room.dealerSeat = 0; room.friendSeat = null;
  const deck = createDeck();
  const pair = (rank) => deck.filter((c) => c.rank === rank && c.suit === "spades").slice(0, 2);
  const plays = [pair("A"), pair("K"), pair("Q"), pair("J"), pair("10")];
  for (let i = 0; i < 5; i += 1) {
    const s = room.seats[i];
    s.playerId = `p${i}`;
    s.nickname = `P${i}`;
    s.hand = [...plays[i]];
  }
  room.currentLeader = 0;
  room.turnSeat = 0;

  playCards(room, "p0", plays[0].map((card) => card.id));

  assert.equal(room.phase, "roundOver");
  assert.deepEqual(room.lastTrick.map((play) => play.seat), [0, 1, 2, 3, 4]);
  assert.deepEqual(room.seats.map((seat) => seat.hand.length), [0, 0, 0, 0, 0]);
  assert.equal(room.currentTrick.length, 0);
});

test("本局结束后真人托管自动取消", () => {
  const room = createRoom("TRUSTEND");
  room.phase = "playing";
  room.levelRank = "2"; room.trumpSuit = "hearts";
  room.dealerSeat = 0;
  room.friendSeat = null;
  const deck = createDeck();
  for (let i = 0; i < 5; i += 1) {
    const s = room.seats[i];
    s.playerId = `p${i}`;
    s.nickname = `P${i}`;
    s.level = "2";
  }
  room.seats[4].isAi = true;
  setTrustee(room, "p0", true);
  assert.equal(room.seats[0].trustee, true);

  const cards = [
    deck.find((c) => c.rank === "A" && c.suit === "spades"),
    deck.find((c) => c.rank === "K" && c.suit === "spades"),
    deck.find((c) => c.rank === "Q" && c.suit === "spades"),
    deck.find((c) => c.rank === "J" && c.suit === "spades"),
    deck.find((c) => c.rank === "9" && c.suit === "spades")
  ];
  for (let i = 0; i < 5; i += 1) room.seats[i].hand = [cards[i]];
  room.currentLeader = 0;
  room.turnSeat = 0;

  playCards(room, "p0", [cards[0].id]);
  assert.equal(room.phase, "roundOver");
  assert.equal(room.seats[0].trustee, false);
  assert.equal(room.seats[4].isAi, true);
});

test("6 人首轮：发完牌进入叫主抢庄，亮主者坐庄", () => {
  const room = createRoom("ROT", { seatCount: 6 });
  for (let i = 0; i < 6; i += 1) { const s = room.seats[i]; s.playerId = `p${i}`; s.nickname = `P${i}`; }
  startRound(room, () => 0.3);
  assert.equal(room.phase, "sixTrump", "6 人发完牌进入叫主抢庄");
  assert.deepEqual(room.teamLevels, { 0: "2", 1: "2" }, "两队都从 2 打起");
  assert.equal(room.dealerSeat, null, "首轮亮主前没有庄家");
  assert.equal(room.levelRank, "2", "首局打 2");
  assert.deepEqual(room.seats.map((s) => s.level), [2, 2, 2, 2, 2, 2].map(String).map((_, i) => room.teamLevels[i % 2]));

  const twoHeart = createDeck().find((card) => card.rank === "2" && card.suit === "hearts");
  room.seats[3].hand.push(twoHeart);
  callSixTrump(room, "p3", [twoHeart.id]);
  for (const i of [0, 1, 2, 4, 5]) passSixTrump(room, `p${i}`);
  assert.equal(room.phase, "burying");
  assert.equal(room.dealerSeat, 3);
  assert.equal(room.trumpSuit, "hearts");
  assert.equal(room.starterSeat, 3);
});

test("6 人首轮抢庄：更高亮主盖过前家时同步改庄家", () => {
  const room = createRoom("COVER6", { seatCount: 6 });
  for (let i = 0; i < 6; i += 1) { const s = room.seats[i]; s.playerId = `p${i}`; s.nickname = `P${i}`; }
  startRound(room, () => 0.3);
  const deck = createDeck();
  const spade2 = deck.find((card) => card.rank === "2" && card.suit === "spades");
  const club2s = deck.filter((card) => card.rank === "2" && card.suit === "clubs").slice(0, 2);
  room.seats[0].hand.push(spade2);
  room.seats[1].hand.push(...club2s);

  callSixTrump(room, "p0", [spade2.id]);
  callSixTrump(room, "p1", club2s.map((card) => card.id));
  for (const i of [0, 2, 3, 4, 5]) passSixTrump(room, `p${i}`);

  assert.equal(room.phase, "burying");
  assert.equal(room.dealerSeat, 1, "首轮抢庄应由更高亮主者坐庄");
  assert.equal(room.trumpSuit, "clubs");
  assert.equal(room.starterSeat, 1);
});

test("6 人已有庄家叫主：只能亮庄家当前等级，闲家队等级不能抢庄", () => {
  const room = createRoom("FIXED6LEVEL", { seatCount: 6 });
  for (let i = 0; i < 6; i += 1) { const s = room.seats[i]; s.playerId = `p${i}`; s.nickname = `P${i}`; }
  room.phase = "sixTrump";
  room.round = 2;
  room.teamLevels = { 0: "3", 1: "4" };
  room.dealerSeat = 0;
  room.sixOriginalDealerSeat = 0;
  room.sixFirstAuction = true; // defensive: stale first-auction flag must not matter once dealer exists
  room.levelRank = "3";

  const deck = createDeck();
  const spade3 = deck.find((card) => card.rank === "3" && card.suit === "spades");
  const club4s = deck.filter((card) => card.rank === "4" && card.suit === "clubs").slice(0, 2);
  room.seats[0].hand.push(spade3);
  room.seats[1].hand.push(...club4s);

  callSixTrump(room, "p0", [spade3.id]);
  assert.throws(() => callSixTrump(room, "p1", club4s.map((card) => card.id)), /当前等级 3/);
  assert.equal(room.dealerSeat, 0);
  assert.equal(room.levelRank, "3");
  assert.equal(room.trumpSuit, "spades");
});

test("6 人已有庄家叫主：闲家盖主只改花色不改庄家", () => {
  const room = createRoom("FIXED6COVER", { seatCount: 6 });
  for (let i = 0; i < 6; i += 1) { const s = room.seats[i]; s.playerId = `p${i}`; s.nickname = `P${i}`; }
  room.phase = "sixTrump";
  room.round = 2;
  room.teamLevels = { 0: "3", 1: "4" };
  room.dealerSeat = 0;
  room.sixOriginalDealerSeat = 0;
  room.sixFirstAuction = true; // defensive: existing dealer means no one can抢庄
  room.levelRank = "3";
  room.starterSeat = 0;

  const deck = createDeck();
  const spade3 = deck.find((card) => card.rank === "3" && card.suit === "spades");
  const club3s = deck.filter((card) => card.rank === "3" && card.suit === "clubs").slice(0, 2);
  room.seats[0].hand.push(spade3);
  room.seats[1].hand.push(...club3s);

  callSixTrump(room, "p0", [spade3.id]);
  callSixTrump(room, "p1", club3s.map((card) => card.id));
  for (const i of [0, 2, 3, 4, 5]) passSixTrump(room, `p${i}`);

  assert.equal(room.phase, "burying");
  assert.equal(room.dealerSeat, 0, "已有庄家时盖主不能改变庄家");
  assert.equal(room.levelRank, "3");
  assert.equal(room.trumpSuit, "clubs");
  assert.equal(room.starterSeat, 0);
});

test("6 人叫主：原庄家队无人亮主则另一队上台，再无人亮主则原庄家重发", () => {
  const room = createRoom("NOCALL", { seatCount: 6 });
  for (let i = 0; i < 6; i += 1) { const s = room.seats[i]; s.playerId = `p${i}`; s.nickname = `P${i}`; s.level = "2"; }
  room.teamLevels = { 0: "7", 1: "9" };
  room.phase = "sixTrump";
  room.dealerSeat = 0;
  room.sixOriginalDealerSeat = 0;
  room.sixTrumpAttempt = 0;
  room.levelRank = "7";
  for (let i = 0; i < 6; i += 1) passSixTrump(room, `p${i}`);
  assert.equal(room.phase, "sixTrump");
  assert.equal(room.dealerSeat, 1, "另一队由原庄家下家上台");
  assert.equal(room.levelRank, "9", "切到另一队等级叫主");
  assert.equal(room.sixTrumpAttempt, 1);

  for (let i = 0; i < 6; i += 1) passSixTrump(room, `p${i}`);
  assert.equal(room.phase, "sixTrump");
  assert.equal(room.dealerSeat, 0, "第二次仍无人亮主则原庄家不变");
  assert.equal(room.levelRank, "7");
  assert.deepEqual(room.seats.map((s) => s.hand.length), [26, 26, 26, 26, 26, 26]);
  assert.equal(room.kitty.length, 6);
});

test("6 人连庄发牌阶段按庄家队等级理牌，换台后才按闲家队等级理牌", () => {
  const room = createRoom("SIXSORT", { seatCount: 6 });
  for (let i = 0; i < 6; i += 1) { const s = room.seats[i]; s.playerId = `p${i}`; s.nickname = `P${i}`; }
  room.round = 1;
  room.teamLevels = { 0: "4", 1: "2" };
  room.nextDealerSeat = 0;
  startRound(room, () => 0.3, { deal: false });

  const deck = createDeck();
  const card = (rank, suit) => deck.find((c) => c.rank === rank && c.suit === suit);
  const spade2 = card("2", "spades");
  const spade4 = card("4", "spades");
  const used = new Set([spade2.id, spade4.id]);
  const fillers = deck.filter((c) => !used.has(c.id)).slice(0, 16);
  room.deck = [
    fillers[0], spade2, fillers[1], fillers[2], fillers[3], fillers[4],
    fillers[5], spade4, fillers[6], fillers[7], fillers[8], fillers[9],
    ...fillers.slice(10, 16)
  ];

  while (dealRound(room)) { /* finish compact test deal */ }
  assert.equal(room.phase, "sixTrump");
  assert.equal(room.dealerSeat, 0);
  assert.equal(room.levelRank, "4");
  assert.deepEqual(room.seats[1].hand.map((c) => c.rank), ["4", "2"], "闲家队等级 2 不能在庄家打 4 时提前当常主");

  for (let i = 0; i < 6; i += 1) passSixTrump(room, `p${i}`);
  assert.equal(room.dealerSeat, 1);
  assert.equal(room.levelRank, "2");
  assert.deepEqual(room.seats[1].hand.map((c) => c.rank), ["2", "4"], "无人亮主换台后才按闲家队等级 2 重排");
});

test("6 人完整发牌连庄时闲家手牌按庄家队等级作为常主排序", () => {
  const room = createRoom("FULLSIXSORT", { seatCount: 6 });
  for (let i = 0; i < 6; i += 1) { const s = room.seats[i]; s.playerId = `p${i}`; s.nickname = `P${i}`; }
  room.round = 1;
  room.teamLevels = { 0: "4", 1: "2" };
  room.nextDealerSeat = 0;
  startRound(room, () => 0.42);

  assert.equal(room.phase, "sixTrump");
  assert.equal(room.dealerSeat, 0);
  assert.equal(room.levelRank, "4");
  for (const seatIndex of [1, 3, 5]) {
    const firstNonJoker = room.seats[seatIndex].hand.find((card) => card.suit !== "joker");
    assert.equal(firstNonJoker?.rank, "4", `seat ${seatIndex} 应先看到庄家队等级 4 的常主`);
  }
});

test("6 人结算分线：120-160 上台不升级，守庄成功才升级", () => {
  assert.deepEqual(upgradeResultSix(45), { side: "dealer", steps: 3, label: "庄家队升 3 级" });
  assert.deepEqual(upgradeResultSix(80), { side: "dealer", steps: 1, label: "庄家队升 1 级" });
  assert.deepEqual(upgradeResultSix(120), { side: "attackers", steps: 0, label: "闲家队上台，不升级" });
  assert.deepEqual(upgradeResultSix(160), { side: "attackers", steps: 0, label: "闲家队上台，不升级" });
  assert.deepEqual(upgradeResultSix(161), { side: "attackers", steps: 1, label: "闲家队上台，升 1 级" });
  assert.deepEqual(upgradeResultSix(201), { side: "attackers", steps: 2, label: "闲家队上台，升 2 级" });
  assert.deepEqual(upgradeResultSix(240), { side: "attackers", steps: 3, label: "闲家队上台，升 3 级" });
});

test("6 人结算轮庄：庄家队守住则同队下一位坐庄并升级", () => {
  const room = createRoom("HOLD6", { seatCount: 6 });
  const deck = createDeck();
  for (let i = 0; i < 6; i += 1) { const s = room.seats[i]; s.playerId = `p${i}`; s.nickname = `P${i}`; s.level = i % 2 === 0 ? "7" : "9"; }
  room.teamLevels = { 0: "7", 1: "9" };
  room.phase = "playing";
  room.dealerSeat = 0;
  room.levelRank = "7";
  room.trumpSuit = "hearts";
  room.noTrump = false;
  room.currentLeader = 0;
  room.turnSeat = 0;
  room.hiddenKitty = [];
  const cards = [
    deck.find((c) => c.rank === "A" && c.suit === "hearts"),
    deck.find((c) => c.rank === "3" && c.suit === "clubs"),
    deck.find((c) => c.rank === "4" && c.suit === "clubs"),
    deck.find((c) => c.rank === "5" && c.suit === "clubs"),
    deck.find((c) => c.rank === "6" && c.suit === "clubs"),
    deck.find((c) => c.rank === "8" && c.suit === "clubs")
  ];
  for (let i = 0; i < 6; i += 1) room.seats[i].hand = [cards[i]];
  playCards(room, "p0", [cards[0].id]);
  assert.equal(room.phase, "roundOver");
  assert.equal(room.lastResult.result.side, "dealer");
  assert.equal(room.nextDealerSeat, 2);
  assert.equal(room.teamLevels[0], "10");
});

test("6 人结算轮庄：120-160 闲家上台不升级，下家坐庄", () => {
  const room = createRoom("UP6", { seatCount: 6 });
  const deck = createDeck();
  const take = (rank, suit, n = 1) => deck.filter((c) => c.rank === rank && c.suit === suit).slice(0, n);
  for (let i = 0; i < 6; i += 1) { const s = room.seats[i]; s.playerId = `p${i}`; s.nickname = `P${i}`; s.level = i % 2 === 0 ? "7" : "9"; }
  room.teamLevels = { 0: "7", 1: "9" };
  room.phase = "playing";
  room.dealerSeat = 0;
  room.levelRank = "7";
  room.trumpSuit = "hearts";
  room.noTrump = false;
  room.currentLeader = 0;
  room.turnSeat = 0;
  room.hiddenKitty = [...take("10", "spades", 3), ...take("K", "clubs", 3)];
  const cards = [
    deck.find((c) => c.rank === "3" && c.suit === "spades"),
    deck.find((c) => c.rank === "A" && c.suit === "hearts"),
    deck.find((c) => c.rank === "4" && c.suit === "clubs"),
    deck.find((c) => c.rank === "5" && c.suit === "clubs"),
    deck.find((c) => c.rank === "6" && c.suit === "clubs"),
    deck.find((c) => c.rank === "8" && c.suit === "clubs")
  ];
  for (let i = 0; i < 6; i += 1) room.seats[i].hand = [cards[i]];
  playCards(room, "p0", [cards[0].id]);
  assert.equal(room.phase, "roundOver");
  assert.equal(room.lastResult.attackers, 125);
  assert.deepEqual(room.lastResult.result, { side: "attackers", steps: 0, label: "闲家队上台，不升级" });
  assert.equal(room.nextDealerSeat, 1);
  assert.deepEqual(room.teamLevels, { 0: "7", 1: "9" });
});

test("4 人 80 分房间：两副牌、每人 25 张、底牌 8 张", () => {
  const room = createRoom("FOUR", { seatCount: 4 });
  assert.equal(room.mode, "classic4");
  assert.equal(room.seatCount, 4);
  assert.equal(room.kittySize, 8);
  assert.equal(room.fixedTeams, true);
  for (let i = 0; i < 4; i += 1) { const s = room.seats[i]; s.playerId = `p${i}`; s.nickname = `P${i}`; }
  startRound(room, () => 0.3);
  assert.equal(room.phase, "sixTrump");
  assert.deepEqual(room.seats.map((seat) => seat.hand.length), [25, 25, 25, 25]);
  assert.equal(room.kitty.length, 8);
});

test("4 人 80 分：亮主坐庄、扣 8 张后直接开打", () => {
  const room = createRoom("FOURPLAY", { seatCount: 4 });
  const deck = createDeck(2);
  for (let i = 0; i < 4; i += 1) { const s = room.seats[i]; s.playerId = `p${i}`; s.nickname = `P${i}`; }
  startRound(room, () => 0.3);
  const twoHeart = deck.find((card) => card.rank === "2" && card.suit === "hearts");
  room.seats[1].hand.push(twoHeart);
  callSixTrump(room, "p1", [twoHeart.id]);
  for (const i of [0, 2, 3]) passSixTrump(room, `p${i}`);
  assert.equal(room.phase, "burying");
  assert.equal(room.dealerSeat, 1);
  assert.equal(room.trumpSuit, "hearts");
  buryKitty(room, "p1", room.seats[1].hand.slice(0, 8).map((card) => card.id));
  assert.equal(room.phase, "playing");
  assert.equal(room.turnSeat, 1);
});

test("4 人 80 分：至少 2 张王可以亮无主", () => {
  const room = createRoom("FOURNT", { seatCount: 4 });
  for (let i = 0; i < 4; i += 1) { const s = room.seats[i]; s.playerId = `p${i}`; s.nickname = `P${i}`; }
  startRound(room, () => 0.3);
  const jokers = [
    { id: "nt-small", copy: 1, suit: "joker", rank: "smallJoker", label: "小王" },
    { id: "nt-big", copy: 1, suit: "joker", rank: "bigJoker", label: "大王" }
  ];
  room.seats[0].hand.push(...jokers);
  callSixTrump(room, "p0", jokers.map((card) => card.id));
  for (const i of [1, 2, 3]) passSixTrump(room, `p${i}`);
  assert.equal(room.phase, "burying");
  assert.equal(room.dealerSeat, 0);
  assert.equal(room.trumpSuit, null);
  assert.equal(room.noTrump, true);
});

test("4 人 80 分已有庄家：闲家盖主只改花色不改庄家", () => {
  const room = createRoom("FOURCOVER", { seatCount: 4 });
  for (let i = 0; i < 4; i += 1) { const s = room.seats[i]; s.playerId = `p${i}`; s.nickname = `P${i}`; }
  room.phase = "sixTrump";
  room.round = 2;
  room.teamLevels = { 0: "3", 1: "4" };
  room.dealerSeat = 0;
  room.sixOriginalDealerSeat = 0;
  room.sixFirstAuction = true; // defensive: existing dealer means no one can抢庄
  room.levelRank = "3";
  room.starterSeat = 0;

  const deck = createDeck(2);
  const spade3 = deck.find((card) => card.rank === "3" && card.suit === "spades");
  const club3s = deck.filter((card) => card.rank === "3" && card.suit === "clubs").slice(0, 2);
  room.seats[0].hand.push(spade3);
  room.seats[1].hand.push(...club3s);

  callSixTrump(room, "p0", [spade3.id]);
  callSixTrump(room, "p1", club3s.map((card) => card.id));
  for (const i of [0, 2, 3]) passSixTrump(room, `p${i}`);

  assert.equal(room.phase, "burying");
  assert.equal(room.dealerSeat, 0, "4 人已有庄家时盖主不能改变庄家");
  assert.equal(room.levelRank, "3");
  assert.equal(room.trumpSuit, "clubs");
  assert.equal(room.starterSeat, 0);
});

test("4 人 80 分已有庄家：闲家不能亮自己等级牌夺庄", () => {
  const room = createRoom("FOURSTEAL", { seatCount: 4 });
  for (let i = 0; i < 4; i += 1) { const s = room.seats[i]; s.playerId = `p${i}`; s.nickname = `P${i}`; }
  room.phase = "sixTrump";
  room.round = 2;
  room.teamLevels = { 0: "2", 1: "3" };
  room.dealerSeat = 0;
  room.sixOriginalDealerSeat = 0;
  room.sixFirstAuction = true; // defensive: stale first-auction flag must not allow夺庄
  room.levelRank = "2";
  room.starterSeat = 0;

  const deck = createDeck(2);
  const club3s = deck.filter((card) => card.rank === "3" && card.suit === "clubs").slice(0, 2);
  room.seats[1].hand.push(...club3s);

  assert.throws(() => callSixTrump(room, "p1", club3s.map((card) => card.id)), /当前等级 2/);
  assert.equal(room.dealerSeat, 0);
  assert.equal(room.levelRank, "2");
  assert.equal(room.trumpSuit, null);
});

test("4 人 80 分结算分档", () => {
  assert.deepEqual(upgradeResultClassic4(0), { side: "dealer", steps: 3, label: "庄家队大光，升 3 级" });
  assert.deepEqual(upgradeResultClassic4(35), { side: "dealer", steps: 2, label: "庄家队小光，升 2 级" });
  assert.deepEqual(upgradeResultClassic4(40), { side: "dealer", steps: 1, label: "庄家队升 1 级" });
  assert.deepEqual(upgradeResultClassic4(80), { side: "attackers", steps: 0, label: "闲家队上台，不升级" });
  assert.deepEqual(upgradeResultClassic4(120), { side: "attackers", steps: 1, label: "闲家队上台，升 1 级" });
  assert.deepEqual(upgradeResultClassic4(160), { side: "attackers", steps: 2, label: "闲家队上台，升 2 级" });
  assert.deepEqual(upgradeResultClassic4(200), { side: "attackers", steps: 3, label: "闲家队上台，升 3 级" });
});

test("4 人 80 分底牌倍率：单×2 对×4 拖拉机固定×8", () => {
  const tractor = (count) => ({ type: "tractor", unit: 2, count });
  assert.equal(buryMultiplierClassic4(null), 2);
  assert.equal(buryMultiplierClassic4({ type: "single" }), 2);
  assert.equal(buryMultiplierClassic4({ type: "pair" }), 4);
  assert.equal(buryMultiplierClassic4(tractor(2)), 8);
  assert.equal(buryMultiplierClassic4(tractor(3)), 8);
  assert.equal(buryMultiplierClassic4(tractor(4)), 8);
});

test("4 人 80 分：4 张拖拉机扣底固定 8 倍（整局结算）", () => {
  const room = createRoom("FOURKITTY", { seatCount: 4 });
  const deck = createDeck(2);
  for (let i = 0; i < 4; i += 1) { const s = room.seats[i]; s.playerId = `p${i}`; s.nickname = `P${i}`; s.level = i % 2 === 0 ? "2" : "2"; }
  room.teamLevels = { 0: "2", 1: "2" };
  room.phase = "playing";
  room.dealerSeat = 0;
  room.levelRank = "2";
  room.trumpSuit = "hearts";
  room.noTrump = false;
  room.currentLeader = 0;
  room.turnSeat = 0;
  room.hiddenKitty = deck.filter((c) => (c.rank === "10" && c.suit === "clubs") || (c.rank === "K" && c.suit === "diamonds")).slice(0, 2);
  const pair = (rank) => deck.filter((c) => c.rank === rank && c.suit === "spades").slice(0, 2);
  const lead = [...pair("3"), ...pair("4")];
  const win = [...pair("6"), ...pair("7")];
  const p2 = [...pair("8"), ...pair("9")];
  const p3 = [...pair("J"), ...pair("Q")];
  const plays = [lead, win, p2, p3];
  for (let i = 0; i < 4; i += 1) room.seats[i].hand = plays[i];
  playCards(room, "p0", plays[0].map((card) => card.id));
  assert.equal(room.phase, "roundOver");
  assert.equal(room.lastResult.buriedBonus, 160); // 8 倍 × 底牌 20 分
  assert.equal(room.lastResult.attackers, 160);
});

test("5 人房间默认配置不变（回归）", () => {
  const room = createRoom("FIVE");
  assert.equal(room.seatCount, 5);
  assert.equal(room.kittySize, 7);
  assert.equal(room.fixedTeams, false);
  assert.equal(room.seats.length, 5);
});

test("通关判定：在 A 上还要升级才算越过 A 夺冠", () => {
  assert.equal(crossesChampion("A", 1), true, "打 A 又升 → 夺冠");
  assert.equal(crossesChampion("A", 3), true);
  assert.equal(crossesChampion("A", 0), false, "没升级不算");
  assert.equal(crossesChampion("K", 1), false, "还没到 A 不算");
  assert.equal(crossesChampion("2", 2), false);
});

test("甩牌扣底倍率：只按其中最大的单一牌型计算", () => {
  // 副花色甩牌（黑桃），主为红桃，级牌 2，便于用普通点数构造组件。
  const room = createRoom("THROWMULT");
  room.levelRank = "2";
  room.trumpSuit = "hearts";
  room.noTrump = false;
  const deck = createDeck(3);
  const pick = (rank, n) => deck.filter((c) => c.rank === rank && c.suit === "spades").slice(0, n);

  // 复数对子 + 单张 → 只算一对（×4，即 pair）。3 与 8 不相连，不构成拖拉机。
  const pairsPlusSingle = [...pick("3", 2), ...pick("8", 2), ...pick("K", 1)];
  assert.deepEqual(dominantThrowShape(pairsPlusSingle, room), { type: "pair", unit: 2, count: 1 });

  // 4 张拖拉机 + 单张 + 对子 + 三条 → 只算拖拉机（×16，即 4 张拖拉机）。
  const big = [...pick("5", 2), ...pick("6", 2), ...pick("9", 1), ...pick("Q", 2), ...pick("J", 3)];
  assert.deepEqual(dominantThrowShape(big, room), { type: "tractor", unit: 2, count: 2 });

  // 三条 + 对子 → 三条（3 张）大于对子（2 张），取三条（×8）。10 与 K 不相连。
  const triplePlusPair = [...pick("10", 3), ...pick("K", 2)];
  assert.deepEqual(dominantThrowShape(triplePlusPair, room), { type: "triple", unit: 3, count: 1 });
});
