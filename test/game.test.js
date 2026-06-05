import test from "node:test";
import assert from "node:assert/strict";
import { createDeck } from "../src/cards.js";
import { addAiPlayer, analyzeShape, chooseAiFriendCard, chooseAiPlay, createRoom, decideAiBid, evaluateBid, revealKittyCard, runAiStep, startAuction, startRound, upgradeResult } from "../src/game.js";

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
