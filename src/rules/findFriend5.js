import { rankNumber, RANKS } from "../cards.js";

export const findFriend5Rules = {
  mode: "findFriend5",
  seatCount: 5,
  deckCopies: 3,
  kittySize: 7,
  fixedTeams: false,
  hasFriend: true
};

export function upgradeResultFindFriend5(attackers) {
  if (attackers <= 40) return { side: "dealer", steps: 3, label: "庄家队升 3 级" };
  if (attackers < 80) return { side: "dealer", steps: 2, label: "庄家队升 2 级" };
  if (attackers < 120) return { side: "dealer", steps: 1, label: "庄家队升 1 级" };
  if (attackers <= 160) return { side: "none", steps: 0, label: "不升不降" };
  if (attackers <= 200) return { side: "attackers", steps: 1, label: "闲家队升 1 级" };
  if (attackers < 240) return { side: "attackers", steps: 2, label: "闲家队升 2 级" };
  return { side: "attackers", steps: 3, label: "闲家队升 3 级" };
}

export function buryMultiplierFindFriend5(shape) {
  if (!shape) return 2;
  if (shape.type === "pair") return 4;
  if (shape.type === "triple") return 8;
  if (shape.type === "tractor") return 2 ** (shape.unit * shape.count);
  return 2;
}

export function evaluateFindFriend5Bid(cards, playerLevel) {
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

export function forceKittyCount(card) {
  if (card.rank === "smallJoker" || card.rank === "bigJoker") return 0;
  if (card.rank === "A") return 1;
  if (card.rank === "J") return 11;
  if (card.rank === "Q") return 12;
  if (card.rank === "K") return 13;
  return Number(card.rank);
}

export function forcedDealerTargetSeat(starterSeat, seatCount, lastKittyCard) {
  const count = forceKittyCount(lastKittyCard);
  let seatIndex = starterSeat;
  for (let i = 1; i < count; i += 1) seatIndex = (seatIndex + 1) % seatCount;
  return { seatIndex, count };
}

export function buildForceSpin(starterSeat, targetSeat, count, lastKittyCard, now = Date.now()) {
  return {
    startSeat: starterSeat,
    targetSeat,
    count,
    startedAt: now,
    intervalMs: 1000,
    holdMs: 1500,
    card: { rank: lastKittyCard.rank, suit: lastKittyCard.suit, label: lastKittyCard.label }
  };
}

export function forceSpinCountdownActive(forceSpin, now = Date.now()) {
  if (!forceSpin) return false;
  const interval = Math.max(0, Number(forceSpin.intervalMs || 0));
  const count = Math.max(0, Number(forceSpin.count ?? 1));
  return now < Number(forceSpin.startedAt || 0) + count * interval;
}
// Shared play-rule engine copied per mode.
export function analyzeShape(cards, room) {
  if (cards.length === 0) return { type: "empty", unit: 0, value: 0 };

  const sorted = [...cards].sort((a, b) => cardOrderValue(b, room) - cardOrderValue(a, room));
  const groups = groupCards(sorted);
  return analyzeShapeFromGroups(cards, room, groups);
}

export function analyzeShapeWithLockedTriples(cards, room, lockedTriples = []) {
  if (cards.length === 0) return { type: "empty", unit: 0, value: 0 };

  const sorted = [...cards].sort((a, b) => cardOrderValue(b, room) - cardOrderValue(a, room));
  const groups = groupCardsRespectingLockedTriples(sorted, lockedTriples);
  return analyzeShapeFromGroups(cards, room, groups);
}

export function analyzeShapeFromGroups(cards, room, groups) {
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
export function isTrueTractor(groups, room) {
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
export function isConsecutiveInRules(cardA, cardB, ledSuit, room) {
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

  if (room.noTrump) {
    if (cardA.rank === "bigJoker") return cardB.rank === "smallJoker";
    if (cardA.rank === "smallJoker") return cardB.rank === level;
    return false;
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
export function getNextImmediateTrumpValue(currentValue, room) {
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
      return { ok: true };
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
    const leaderShapeForLock = analyzeShape(leaderCards, room);
    const wantedForLock = forcedRequirement(leaderShapeForLock, availForLock, room, seat.lockedTriples || []);
    const lockedPairNeeded = !requirementSatisfiedWithoutLockedPair(cards, wantedForLock, room, lockedKey);
    if (competitive && !forced && lockedPairNeeded) {
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
    const leaderLockedTriples = room.currentTrick[0]?.cards === leaderCards
      ? lockedTriplesForPlay(room, room.currentTrick[0])
      : [];
    return validateThrowFollow(room, seat, cards, leaderCards, ledSuit, available, leaderLockedTriples);
  }

  if (following.length === cards.length) {
    const wanted = forcedRequirement(leaderShape, available, room, seat.lockedTriples || []);
    const actual = analyzeShapeWithLockedTriples(cards, room, seat.lockedTriples || []);
    const followingSameSuit = cards.filter((c) => playSuit(c, room) === ledSuit);
    if (!shapeSatisfies(actual, wanted, followingSameSuit, available, room, seat.lockedTriples || [])) {
      return { ok: false, reason: "需要优先跟同类牌型" };
    }
  }
  return { ok: true };
}

// When following a throw, each atomic group in the leader's throw must be matched
// with the best same-size group the follower can produce from same-suit cards.
export function validateThrowFollow(room, seat, cards, leaderCards, ledSuit, available, leaderLockedTriples = []) {
  const leaderSorted = [...leaderCards].sort((a, b) => cardOrderValue(b, room) - cardOrderValue(a, room));
  const leaderGroups = groupCardsRespectingLockedTriples(leaderSorted, leaderLockedTriples); // e.g. [[A,A,A],[Q,Q],[J]]

  // Build what follower MUST contribute per group
  let mustPairs = 0;    // number of pairs required
  let mustTriples = 0;  // number of triples required
  let mustSingles = 0;  // number of singles required

  const availGroups = groupCards([...available].sort((a, b) => cardOrderValue(b, room) - cardOrderValue(a, room)));
  // 锁定的三条不能拆成对子出，不计入“可用对子”（计入会与锁定规则冲突造成死锁）；
  // 整组三张打出不算拆对，所以三条数照常统计。
  const lockedSet = new Set(seat.lockedTriples || []);
  const isLockedGroup = (g) => lockedSet.has(`${g[0].rank}|${g[0].suit}`);
  const availPairs   = availGroups.filter(g => g.length === 2 && !isLockedGroup(g)).length;
  const availTriples = availGroups.filter(g => g.length >= 3).length;
  const playedSameSuit = cards.filter(c => playSuit(c, room) === ledSuit);

  // 甩牌里如果包含拖拉机组件，跟家手里有对应拖拉机时必须优先跟拖拉机；
  // 不能只用散对子凑数量（例如首家 7788，跟家有 991010 时不能出 9944）。
  const components = decomposeThrowComponents(leaderCards, room, ledSuit, leaderLockedTriples);
  for (const comp of components) {
    if (comp.kind !== "tractor") continue;
    const need = comp.unit * comp.count;
    const pool = comp.unit === 2
      ? naturalPairPool(available, room, lockedSet)
      : available;
    const playedPool = comp.unit === 2
      ? naturalPairPool(playedSameSuit, room, lockedSet)
      : playedSameSuit;
    if (findTractors(pool, room, need).length && !findTractors(playedPool, room, need).length) {
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
  const playedGroups = groupCardsRespectingLockedTriples(
    [...playedSameSuit].sort((a, b) => cardOrderValue(b, room) - cardOrderValue(a, room)),
    lockedSet
  );
  const playedPairs   = playedGroups.filter(g => g.length === 2).length;
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
export function decomposeThrowComponents(cards, room, ledSuit, lockedTriples = []) {
  const sorted = [...cards].sort((a, b) => cardOrderValue(b, room) - cardOrderValue(a, room));
  const groups = groupCardsRespectingLockedTriples(sorted, lockedTriples);
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
export function opponentHasBetterTractor(otherSameSuit, room, unit, count, headValue, ledSuit, lockedTriples = []) {
  const lockedSet = new Set(lockedTriples || []);
  const oGroups = groupCards(
    [...otherSameSuit].sort((a, b) => cardOrderValue(b, room) - cardOrderValue(a, room))
  );
  const canUseGroup = (g) => {
    if (g.length < unit) return false;
    return unit !== 2 || !lockedSet.has(`${g[0].rank}|${g[0].suit}`);
  };
  let i = 0;
  while (i < oGroups.length) {
    if (canUseGroup(oGroups[i])) {
      let j = i;
      const run = [oGroups[i]];
      while (
        j + 1 < oGroups.length &&
        canUseGroup(oGroups[j + 1]) &&
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
export function validateThrow(room, throwerSeat, cards) {
  const ledSuit = playSuit(cards[0], room);
  const components = decomposeThrowComponents(cards, room, ledSuit, throwerSeat.lockedTriples || []);

  const allBlocked = []; // { cards, headValue, reason }

  for (const otherSeat of room.seats) {
    if (otherSeat.index === throwerSeat.index) continue;
    const otherSameSuit = otherSeat.hand.filter((c) => playSuit(c, room) === ledSuit);
    if (otherSameSuit.length === 0) continue;
    const lockedSet = new Set(otherSeat.lockedTriples || []);
    const oGroups = groupCards(
      [...otherSameSuit].sort((a, b) => cardOrderValue(b, room) - cardOrderValue(a, room))
    );

    for (const comp of components) {
      const headValue = cardOrderValue(comp.cards[0], room);

      if (comp.kind === "tractor") {
        if (opponentHasBetterTractor(otherSameSuit, room, comp.unit, comp.count, headValue, ledSuit, otherSeat.lockedTriples || [])) {
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
        (oGroup) => oGroup.length >= comp.unit
          && (comp.unit !== 2 || !lockedSet.has(`${oGroup[0].rank}|${oGroup[0].suit}`))
          && cardOrderValue(oGroup[0], room) > headValue
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
export function findThrowKeepCards(cards, blockedGroup, room) {
  if (blockedGroup && blockedGroup.length > 0) {
    return blockedGroup;
  }
  // Fallback: keep smallest single card
  const sorted = [...cards].sort((a, b) => cardOrderValue(a, room) - cardOrderValue(b, room));
  return [sorted[0]];
}

// 补充辅助函数：检查两手牌的牌型原子结构是否完全对齐（处理甩牌跟牌校验）
export function isStructureMatch(cardsA, cardsB) {
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

// 【彻底修复 2】：完善墩牌大小裁判，防止垫牌、不匹配牌型盗取胜利
export function comparePlay(room, challenger, currentBest, leadPlay) {
  const leadPlayCards = leadPlay.cards;
  const leadLockedTriples = lockedTriplesForPlay(room, leadPlay);
  const leadShape = analyzeShapeWithLockedTriples(leadPlayCards, room, leadLockedTriples);
  const ledSuit = playSuit(leadPlayCards[0], room);

  const challengerCards = challenger.cards;
  const challengerLockedTriples = lockedTriplesForPlay(room, challenger);
  const challengerShape = analyzeShapeWithLockedTriples(challengerCards, room, challengerLockedTriples);
  const challengerSuit = playSuit(challengerCards[0], room);

  const bestCards = currentBest.cards;
  const bestLockedTriples = lockedTriplesForPlay(room, currentBest);
  const bestShape = analyzeShapeWithLockedTriples(bestCards, room, bestLockedTriples);
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
      if (throwStructureMatch(challengerCards, leadPlayCards, room, challengerLockedTriples, leadLockedTriples)) {
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
    if (leadShape.type === "throw") {
      return compareByHighestTier(challengerCards, bestCards, room, leadPlayCards, {
        allowLargerGroups: true,
        challengerLockedTriples,
        bestLockedTriples,
        leaderLockedTriples: leadLockedTriples
      });
    }
    return getShapeComparativeValue(challengerCards, room) - getShapeComparativeValue(bestCards, room);
  }

  if (bestIsTrumpCut) return -1;

  if (leadShape.type === "throw") {
    return compareByHighestTier(challengerCards, bestCards, room, leadPlayCards, {
      challengerLockedTriples,
      bestLockedTriples,
      leaderLockedTriples: leadLockedTriples
    });
  }

  return getShapeComparativeValue(challengerCards, room) - getShapeComparativeValue(bestCards, room);
}

export function lockedTriplesForPlay(room, play) {
  return room.seats?.[play.seat]?.lockedTriples || [];
}

// For throw tricks: first identify the leader's highest component tier, then
// compare only that tier. If the leader threw only singles (e.g. A+K), a later
// pair is just two single cards; the pair tier must not outrank the leader.
export function compareByHighestTier(challengerCards, bestCards, room, leaderCards, options = {}) {
  const leaderInfo = highestThrowTier(leaderCards, room, options.leaderLockedTriples || []);
  const c = matchingThrowTierValue(challengerCards, room, leaderInfo, options.challengerLockedTriples || [], options);
  const b = matchingThrowTierValue(bestCards, room, leaderInfo, options.bestLockedTriples || [], options);
  if (c.value !== b.value) return c.value - b.value;
  return -1; // same tier and value → earlier play wins
}

export function highestThrowTier(cards, room, lockedTriples = []) {
  const ledSuit = playSuit(cards[0], room);
  const components = decomposeThrowComponents(cards, room, ledSuit, lockedTriples);
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

export function matchingThrowTierValue(cards, room, target, lockedTriples = [], { allowLargerGroups = false } = {}) {
  if (target.tier === 1) {
    return { value: Math.max(...cards.map((card) => cardOrderValue(card, room))) };
  }
  const ledSuit = playSuit(cards[0], room);
  const components = decomposeThrowComponents(cards, room, ledSuit, lockedTriples);
  let value = -Infinity;
  for (const comp of components) {
    if (target.tier === 4) {
      if (comp.kind === "tractor" && comp.unit === target.unit && comp.count >= target.count) {
        value = Math.max(value, cardOrderValue(comp.cards[0], room));
      }
    } else if (comp.kind === "tractor" && comp.unit === target.unit && comp.count >= target.count) {
      value = Math.max(value, cardOrderValue(comp.cards[0], room));
    } else if (comp.kind === "group" && (comp.unit === target.unit || (allowLargerGroups && comp.unit > target.unit))) {
      value = Math.max(value, cardOrderValue(comp.cards[0], room));
    }
  }
  return { value };
}



// 辅助函数：判断一组牌是否全为主牌
export function isAllTrumpCards(cards, room) {
  return cards.every(card => playSuit(card, room) === "trump");
}

// Check if trump cut cards match the structural composition of the leader's throw.
// e.g. leader throws AAA+QQ+J (triple+pair+single) → trump cut must also be triple+pair+single.
export function throwStructureMatch(trumpCards, leaderCards, room, trumpLockedTriples = [], leaderLockedTriples = []) {
  const getStructure = (cards, lockedTriples = []) => {
    const ledSuit = playSuit(cards[0], room);
    const components = decomposeThrowComponents(cards, room, ledSuit, lockedTriples);
    const counts = { tractor: 0, triple: 0, pair: 0, single: 0, tripleUnits: 0, pairUnits: 0 };
    for (const comp of components) {
      if (comp.kind === "tractor") {
        counts.tractor++;
        if (comp.unit === 3) counts.tripleUnits += comp.count;
        if (comp.unit === 2) counts.pairUnits += comp.count;
      } else if (comp.unit >= 3) {
        counts.triple++;
        counts.tripleUnits++;
      } else if (comp.unit === 2) {
        counts.pair++;
        counts.pairUnits++;
      } else {
        counts.single++;
      }
    }
    return counts;
  };
  const ls = getStructure(leaderCards, leaderLockedTriples);
  const ts = getStructure(trumpCards, trumpLockedTriples);
  if (ls.tractor > 0) {
    return ls.tractor === ts.tractor && ls.triple === ts.triple &&
           ls.pair === ts.pair && ls.single === ts.single;
  }
  // 非拖拉机甩牌：总张数已在外层校验相等。主牌只要有足够的三条/对子覆盖甩牌的
  // 三条与对子即可——更强的牌型（三条可当对子、对子可拆成单张）能下顶更弱的需求，
  // 多出来的牌自然覆盖甩牌里的单张。故不再单独要求“单张数 >= 甩牌单张数”。
  return ts.tripleUnits >= ls.triple
    && (ts.tripleUnits + ts.pairUnits) >= (ls.triple + ls.pair);
}


// 辅助函数：获取牌型的真正用于比较的核心权重（解决只比最大单张的 Bug）
// 比如对子比对子的大小，拖拉机比拖拉机车头的大小
export function getShapeComparativeValue(cards, room) {
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

export function playSuit(card, room) {
  if (card.rank === "bigJoker" || card.rank === "smallJoker") return "trump";
  if (card.rank === room.levelRank) return "trump";
  if (!room.noTrump && card.suit === room.trumpSuit) return "trump";
  return card.suit;
}

// 检测一手牌里是否“把某副已锁定的三条拆成了对子”：即出现一个恰好两张、
// 且其点数花色属于该座位锁定集合的组。返回锁定键 "rank|suit"，否则 null。
export function lockedPairViolation(seat, cards, room) {
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

export function requirementSatisfiedWithoutLockedPair(cards, wanted, room, lockedKey) {
  if (!wanted || wanted.type === "any") return true;
  const filtered = cards.filter((c) => `${c.rank}|${c.suit}` !== lockedKey);
  const sorted = [...filtered].sort((a, b) => cardOrderValue(b, room) - cardOrderValue(a, room));
  const groups = groupCards(sorted);

  if (wanted.type === "tractor") {
    if (wanted.unit === 3) {
      const run = findBestTractorRun(filtered, room, 3);
      return !!run && run.length >= wanted.count;
    }
    return findTractors(filtered, room, wanted.count * wanted.unit).length > 0;
  }
  if (wanted.type === "pairs") {
    return groups.filter((g) => wanted.unit === 2 ? g.length === 2 : g.length >= wanted.unit).length >= wanted.count;
  }
  if (wanted.type === "tripleFallback") {
    const triples = groups.filter((g) => g.length >= 3).length;
    const pairs = groups.filter((g) => g.length >= 2 && g.length < 3).length;
    return triples >= wanted.triples && pairs >= wanted.pairs;
  }
  if (wanted.type === "pairTractorFallback") {
    const run = findBestTractorRun(filtered, room, 2);
    const pairs = groups.filter((g) => g.length === 2).length;
    return !!run && run.length >= wanted.tractorPairs && pairs >= wanted.pairs;
  }
  if (wanted.type === "triple") return groups.some((g) => g.length >= 3);
  if (wanted.type === "pair") return groups.some((g) => g.length === 2);
  return true;
}

// 在“需要对子但天然对子不够”的选择时刻记录玩家是否保留了三条：
// 若对子需求已由天然对子满足，三条没有参与选择，不锁；
// 若天然对子不足而玩家没有把某副三条拆成对子，则这副三条本局之后不得再拆成对子。
export function recordTripleLockDecision(room, seat, cards, leaderCards) {
  const leaderShape = analyzeShape(leaderCards, room);
  const ledSuit = playSuit(leaderCards[0], room);
  const playedAllTrumpCut = ledSuit !== "trump" && cards.every((c) => playSuit(c, room) === "trump");
  const poolSuit = playedAllTrumpCut ? "trump" : ledSuit;
  const available = seat.hand.filter((c) => playSuit(c, room) === poolSuit); // 出牌前的手牌
  const pairDemand = pairDemandForTripleChoice(leaderShape, leaderCards, room);
  if (pairDemand <= 0) return;

  const groups = groupCards([...available].sort((a, b) => cardOrderValue(b, room) - cardOrderValue(a, room)));
  const naturalPairs = groups.filter((g) => g.length === 2).length;
  if (naturalPairs >= pairDemand) return;
  const triples = groups.filter((g) => g.length >= 3);
  if (triples.length === 0) return;
  if (!seat.lockedTriples) seat.lockedTriples = [];
  for (const t of triples) {
    const key = `${t[0].rank}|${t[0].suit}`;
    if (seat.lockedTriples.includes(key)) continue;
    const playedOfKey = cards.filter((c) => c.rank === t[0].rank && c.suit === t[0].suit).length;
    if (playedOfKey < 2) seat.lockedTriples.push(key); // 没拆成对子 → 锁定
  }
}

export function pairDemandForTripleChoice(leaderShape, leaderCards, room) {
  if (leaderShape.type === "pair") return 1;
  if (leaderShape.type === "tractor" && leaderShape.unit === 2) return leaderShape.count;
  if (leaderShape.type !== "throw") return 0;
  const ledSuit = playSuit(leaderCards[0], room);
  const leaderLockedTriples = room.currentTrick[0]?.cards === leaderCards
    ? lockedTriplesForPlay(room, room.currentTrick[0])
    : [];
  return decomposeThrowComponents(leaderCards, room, ledSuit, leaderLockedTriples).reduce((sum, comp) => {
    if (comp.kind === "tractor" && comp.unit === 2) return sum + comp.count;
    if (comp.kind === "group" && comp.unit === 2) return sum + 1;
    return sum;
  }, 0);
}

export function forcedRequirement(leaderShape, available, room, lockedTriples = []) {
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
      const pairPool = naturalPairPool(available, room, lockedSet);
      const pairRun = findBestTractorRun(pairPool, room, 2);
      const pairAvail = groupCards(pairPool).filter((g) => g.length === 2).length;
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
      ? naturalPairPool(available, room, lockedSet)
      : available;
    const tractors = findTractors(tractorPool, room, leaderShape.count * leaderShape.unit);
    if (tractors.length) return { type: "tractor", unit: leaderShape.unit, count: leaderShape.count };
    const pairsAvail = groupCards(available).filter((g) =>
      leaderShape.unit === 2 ? g.length === 2 && !isLockedGroup(g) : g.length >= leaderShape.unit && !isLockedGroup(g)
    );
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

export function naturalPairPool(cards, room, lockedSet = new Set()) {
  const groups = groupCards([...cards].sort((a, b) => cardOrderValue(b, room) - cardOrderValue(a, room)));
  const allowed = new Set();
  for (const g of groups) {
    if (g.length === 2 && !lockedSet.has(`${g[0].rank}|${g[0].suit}`)) {
      for (const c of g) allowed.add(c.id);
    }
  }
  return cards.filter((c) => allowed.has(c.id));
}

export function shapeSatisfies(actual, wanted, cards, available, room, lockedTriples = []) {
  if (wanted.type === "any") return true;

  // Sort before grouping so detection never depends on the order cards were picked.
  const sorted = [...cards].sort((a, b) => cardOrderValue(b, room) - cardOrderValue(a, room));
  const lockedSet = lockedTriples instanceof Set ? lockedTriples : new Set(lockedTriples || []);
  const groups = groupCardsRespectingLockedTriples(sorted, lockedSet);

  if (wanted.type === "tractor") {
    return actual.type === "tractor" && actual.unit === wanted.unit && actual.count >= wanted.count;
  }

  if (wanted.type === "pairs") {
    // 对子要求只认天然对子；三条不能被强制拆成对子。
    return groups.filter((g) => wanted.unit === 2 ? g.length === 2 : g.length >= wanted.unit).length >= wanted.count;
  }

  if (wanted.type === "tripleFallback") {
    const triples = groups.filter((g) => g.length >= 3).length;
    const pairs = groups.filter((g) => g.length >= 2 && g.length < 3).length;
    return triples >= wanted.triples && pairs >= wanted.pairs;
  }

  if (wanted.type === "pairTractorFallback") {
    const run = findBestTractorRun(naturalPairPool(cards, room, lockedSet), room, 2);
    const pairs = groups.filter((g) => g.length === 2).length;
    return !!run && run.length >= wanted.tractorPairs && pairs >= wanted.pairs;
  }

  if (wanted.type === "triple") {
    // Must contain at least one group of 3
    return groups.some((g) => g.length >= 3);
  }

  if (wanted.type === "pair") {
    // Must contain at least one natural pair; triples may be kept intact.
    return groups.some((g) => g.length === 2);
  }

  return true;
}

// 辅助函数：将相同点数和花色的牌归类到一个组中
export function groupCards(sortedCards) {
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

export function groupCardsRespectingLockedTriples(sortedCards, lockedTriples = []) {
  const lockedSet = lockedTriples instanceof Set ? lockedTriples : new Set(lockedTriples || []);
  const groups = groupCards(sortedCards);
  if (lockedSet.size === 0) return groups;
  return groups.flatMap((g) => {
    const key = `${g[0].rank}|${g[0].suit}`;
    return g.length === 2 && lockedSet.has(key) ? g.map((card) => [card]) : [g];
  });
}

export function tractorUnitSize(groups) {
  if (groups.length < 2) return 0;
  if (groups.every((group) => group.length >= 3)) return 3;
  if (groups.every((group) => group.length >= 2)) return 2;
  return 0;
}

// 修复：考虑当前级牌（levelRank）被抽离后的动态连续性判定
export function isConsecutiveGroups(groups, room) {
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
export function findTractors(cards, room, length) {
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

export function findBestTractorRun(cards, room, unit = 2) {
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

export function hasGroup(cards, size) {
  return groupCards(cards).some((group) => group.length >= size);
}

// 把一手甩牌拆成结构组件，取“张数最多”的那个组件，合成等价的单一牌型 shape。
// 倍率随张数单调递增（2^张数），故张数最多 = 倍率最高，符合“只算最大牌型”的规则。
export function dominantThrowShape(cards, room, lockedTriples = []) {
  const ledSuit = playSuit(cards[0], room);
  const components = decomposeThrowComponents(cards, room, ledSuit, lockedTriples);
  let top = null;
  for (const comp of components) {
    if (!top || comp.cards.length > top.cards.length) top = comp;
  }
  if (!top) return { type: "single", unit: 1, count: 1 };
  if (top.kind === "tractor") return { type: "tractor", unit: top.unit, count: top.count };
  if (top.unit === 3) return { type: "triple", unit: 3, count: 1 };
  if (top.unit === 2) return { type: "pair", unit: 2, count: 1 };
  return { type: "single", unit: 1, count: 1 };
}

export function trumpKillSeats(room, plays = room.currentTrick) {
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
