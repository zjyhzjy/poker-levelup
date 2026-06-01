import test from "node:test";
import assert from "node:assert/strict";
import { createDeck } from "../src/cards.js";
import { addAiPlayer, analyzeShape, createRoom, evaluateBid, runAiStep, startAuction, startRound, upgradeResult } from "../src/game.js";

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
  room.seats[0].playerId = "human";
  room.seats[0].nickname = "真人";
  room.seats[0].connected = true;
  for (let i = 1; i < 5; i += 1) addAiPlayer(room, i);
  startRound(room, () => 0.2);
  startAuction(room);
  let guard = 0;
  while (runAiStep(room) && guard < 20) guard += 1;
  assert.ok(["forcedSuit", "burying", "friend", "playing"].includes(room.phase));
});
