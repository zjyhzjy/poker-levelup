import test from "node:test";
import assert from "node:assert/strict";
import { createDeck } from "../src/cards.js";
import { addAiPlayer, analyzeShape, chooseAiFriendCard, chooseAiPlay, createRoom, decideAiBid, evaluateBid, makeBid, passBid, revealKittyCard, runAiStep, sit, startAuction, startRound, upgradeResult, validatePlay } from "../src/game.js";

test("三副牌共 162 张", () => {
  assert.equal(createDeck().length, 162);
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
  // From here AI advances forcedSuit → burying → friend → playing on its own.
  let guard = 0;
  while (runAiStep(room) && guard < 80) guard += 1;
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
  // 把锁定三条拆成对子仍然非法（并非别无他法）
  assert.equal(validatePlay(room, ai, ai.hand.slice(0, 2), bigJokers).ok, false);
  // AI 必须给出一手合法牌
  const play = chooseAiPlay(room, ai, bigJokers);
  assert.equal(validatePlay(room, ai, play, bigJokers).ok, true);
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
  // 含锁定对的跟牌仍然非法
  assert.equal(validatePlay(room, ai, [ai.hand[2], ai.hand[3], ai.hand[0]], club3s).ok, false);
  // AI 必须给出一手合法牌
  const play = chooseAiPlay(room, ai, club3s);
  assert.equal(validatePlay(room, ai, play, club3s).ok, true);
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
