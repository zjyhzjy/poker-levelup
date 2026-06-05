/* ─── State ──────────────────────────────────────────────── */
// Stable, client-owned player identity. Generated once and reused forever so we
// can always reclaim our seat after a refresh, app switch, or dropped connection.
function getMyId() {
  let id = localStorage.getItem("szp.playerId");
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) || `id_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    localStorage.setItem("szp.playerId", id);
  }
  return id;
}

const state = {
  ws: null,
  playerId: getMyId(),
  nickname: localStorage.getItem("szp.nickname") || "",
  room: null,
  selected: new Set()
};

const $ = (sel) => document.querySelector(sel);

// Tracks the currently shown bid so the center reveal only re-animates on change
let lastBidSig = "";
// Card ids that have already played their deal-in animation, so re-renders during
// dealing don't make the whole hand flicker (only newly dealt cards animate).
const dealtCardIds = new Set();

/* ─── Join Screen ────────────────────────────────────────── */
$("#nickname").value = state.nickname;

$("#joinForm").addEventListener("submit", (e) => {
  e.preventDefault();
  connectAndJoin($("#roomCode").value.trim(), $("#nickname").value.trim());
});

$("#createRoom").addEventListener("click", () => {
  connectAndJoin("", $("#nickname").value.trim());
});

// On load, if we were in a room before, prefill the code and try to reconnect.
// If the room is gone, the server replies with an error and we stay on the join
// screen so the player can create/join a fresh room.
(() => {
  const lastRoom = localStorage.getItem("szp.roomCode");
  if (lastRoom) {
    $("#roomCode").value = lastRoom;
    if (state.nickname) connectAndJoin(lastRoom, state.nickname);
  }
})();

function connectAndJoin(code, nickname) {
  state.nickname = nickname || "玩家";
  localStorage.setItem("szp.nickname", state.nickname);
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}`);
  state.ws = ws;
  // Only join once per socket. The server may send another "hello" after a
  // reconnect join; without this guard we'd loop hello→join→hello forever.
  let joined = false;
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "hello") {
      // Ignore the server's temporary id — we always identify with our stable id
      // so the server keys our seat by it and reconnects map back to us.
      if (!joined) {
        joined = true;
        state.playerId = getMyId();
        send(code ? "joinRoom" : "createRoom", { code, nickname: state.nickname, playerId: state.playerId });
      }
    }
    if (msg.type === "state") {
      state.room = msg.payload;
      // Remember the room so a refresh / reopen can auto-reconnect us back in.
      if (state.room.code) localStorage.setItem("szp.roomCode", state.room.code);
      // Preserve selected cards that are still in hand
      const hand = msg.payload.seats.find(s => s.isYou)?.hand || [];
      const handIds = new Set(hand.map(c => c.id));
      for (const id of [...state.selected]) {
        if (!handIds.has(id)) state.selected.delete(id);
      }
      render();
    }
    if (msg.type === "error") showError(msg.payload.message);
  });
}

function send(type, payload = {}) {
  state.ws?.send(JSON.stringify({ type, payload }));
}

/* ─── Root Render ────────────────────────────────────────── */
function render() {
  document.querySelector('[data-view="join"]').classList.add("hidden");
  document.querySelector('[data-view="game"]').classList.remove("hidden");

  const room = state.room;
  $("#roomBadge").textContent = `房间 ${room.code}`;
  $("#phaseBadge").textContent = phaseText(room.phase);

  const trump = room.noTrump ? "无主" : (room.trumpSuit ? suitSymbol(room.trumpSuit) : "-");
  $("#roundInfo").textContent = `第${room.round || 0}局 · 打${room.levelRank || "-"} · 主${trump}`;

  try { renderSeats(room); }    catch(e) { console.error("renderSeats:", e); }
  try { renderCenter(room); }   catch(e) { console.error("renderCenter:", e); }
  try { renderControls(room); } catch(e) { console.error("renderControls:", e); }
  try { renderHand(room); }     catch(e) { console.error("renderHand:", e); }
  try { renderLog(room); }      catch(e) { console.error("renderLog:", e); }
}

/* ─── Seats + Played Cards ───────────────────────────────── */
/* ─── Seats + Played Cards ───────────────────────────────── */
// Screen positions (0=bottom-center/you, 1=bottom-right, 2=top-right, 3=top-left, 4=bottom-left)
function seatToScreenPos(serverIndex, viewerSeatIndex) {
  return (serverIndex - viewerSeatIndex + 5) % 5;
}

function renderSeats(room) {
  const seatsEl = document.querySelector("#seats");

  const currentPlayed = {};
  for (const play of room.currentTrick) currentPlayed[play.seat] = play.cards;
  const lastPlayed = {};
  for (const play of (room.lastTrick || [])) lastPlayed[play.seat] = play.cards;

  const isDealer = (i) => room.dealerSeat === i;
  const isFriend = (i) => room.friendSeat !== null && room.friendSeat === i;
  const friendRevealed = room.friendSeat !== null;
  const inBiddingPhase = ["dealing","auctionReady","auction"].includes(room.phase);
  const showBids = ["dealing","auctionReady","auction","forcedSuit","burying"].includes(room.phase);
  const seatBids = room.seatBids || {};
  const bidResponses = room.bidResponses || {};
  const viewerSeatIndex = room.viewerSeat ?? 0;

  seatsEl.innerHTML = room.seats.map((seat) => {
    const screenPos = seatToScreenPos(seat.index, viewerSeatIndex);
    const initial = (seat.nickname || "?")[0].toUpperCase();
    const isActive = room.phase === "playing" && room.turnSeat === seat.index;
    const youClass = seat.isYou ? "you" : "";
    const activeClass = isActive ? "active" : "";

    // Role badge
    let roleBadge = "";
    if (isDealer(seat.index) && room.dealerSeat !== null) {
      roleBadge = `<div class="role-badge dealer-badge">庄</div>`;
    } else if (isFriend(seat.index)) {
      roleBadge = `<div class="role-badge friend-badge">友</div>`;
    }

    // Bid response indicator
    let bidIndicator = "";
    if (inBiddingPhase) {
      const resp = bidResponses[seat.index];
      if (resp === "pass") bidIndicator = `<div class="bid-indicator pass">不抢</div>`;
    }

    // Cards beside seat — bottom seats (pos 1,4) show cards ABOVE the token
    const playedAbove = screenPos === 1 || screenPos === 4;
    let sideCardsHTML = "";
    if (showBids && seatBids[seat.index]) {
      sideCardsHTML = renderPlayedCards(seatBids[seat.index].cards);
    } else {
      let playedCards = null;
      if (currentPlayed[seat.index]) {
        playedCards = currentPlayed[seat.index];
      } else if (room.currentTrick.length === 0 && lastPlayed[seat.index]) {
        playedCards = lastPlayed[seat.index];
      }
      if (playedCards) sideCardsHTML = renderPlayedCards(playedCards);
    }

    // Personal score
    let personalScore = "";
    if (room.phase === "playing" || room.phase === "roundOver") {
      if (!friendRevealed && !isDealer(seat.index) && seat.playerId) {
        const ps = (room.seatPersonalScores || {})[seat.index] ?? 0;
        const pts = seat.takenTrickPoints + ps;
        const color = pts < 0 ? "#ff6b6b" : "var(--gold-light)";
        personalScore = `<div class="personal-score" style="color:${color}">${pts}分</div>`;
      }
    }

    // Seat action buttons (lobby only)
    let actionsHTML = "";
    if (room.phase === "lobby") {
      if (!seat.playerId) {
        actionsHTML = `<div class="seat-actions">
          <button class="seat-btn" data-sit="${seat.index}">坐下</button>
          <button class="seat-btn" data-ai="${seat.index}">加AI</button>
        </div>`;
      } else if (seat.isYou) {
        actionsHTML = `<div class="seat-actions"><button class="seat-btn" data-leave>离座</button></div>`;
      }
    }

    const levelText = seat.level ? `Lv.${seat.level}` : "";
    const statusText = seat.playerId
      ? `${seat.isAi ? "AI" : (seat.connected ? "在线" : "离线")} · ${seat.handCount}张`
      : "空座";

    const playedDiv = sideCardsHTML
      ? `<div class="seat-played">${sideCardsHTML}</div>`
      : "";

    return `<div class="seat screen-pos-${screenPos} ${youClass} ${activeClass}">
      ${playedAbove ? playedDiv : ""}
      <div class="seat-token-wrap">
        ${roleBadge}
        <div class="seat-token">${initial}</div>
        ${personalScore}
      </div>
      <div class="seat-name">${seat.nickname || `座位${seat.index + 1}`}</div>
      <div class="seat-info">${statusText}${levelText ? " · " + levelText : ""}</div>
      ${bidIndicator}
      ${actionsHTML}
      ${!playedAbove ? playedDiv : ""}
    </div>`;
  }).join("");

  seatsEl.querySelectorAll("[data-sit]").forEach(btn =>
    btn.addEventListener("click", () => send("sit", { seatIndex: Number(btn.dataset.sit), nickname: state.nickname })));
  seatsEl.querySelectorAll("[data-ai]").forEach(btn =>
    btn.addEventListener("click", () => send("addAi", { seatIndex: Number(btn.dataset.ai) })));
  seatsEl.querySelectorAll("[data-leave]").forEach(btn =>
    btn.addEventListener("click", () => send("leaveSeat")));
}

/* ─── Played Cards HTML (beside seat) ───────────────────── */
function renderPlayedCards(cards) {
  if (!cards || cards.length === 0) return "";

  const CARD_W = 50;
  const CARD_H = 71;
  // Max container width available beside a seat (keep it compact)
  const MAX_WIDTH = 170;
  // Calculate offset per card so all fit within MAX_WIDTH
  const offset = cards.length === 1
    ? 0
    : Math.min(34, Math.floor((MAX_WIDTH - CARD_W) / (cards.length - 1)));
  const totalWidth = CARD_W + (cards.length - 1) * offset;

  const inner = cards.map((card, i) =>
    `<div style="position:absolute;left:${i * offset}px;top:0;z-index:${i + 1};">
      ${playedCardHTML(card)}
    </div>`
  ).join("");

  return `<div style="position:relative;width:${totalWidth}px;height:${CARD_H}px;flex-shrink:0;">${inner}</div>`;
}

function playedCardHTML(card) {
  const colorClass = isRed(card) ? "red" : (card.suit === "joker" ? "joker" : "black");
  const jokerClass = card.rank === "bigJoker" ? "big-joker" : "";

  if (card.rank === "bigJoker" || card.rank === "smallJoker") {
    const label = card.rank === "bigJoker" ? "大" : "小";
    const jokerTop = card.rank === "bigJoker" ? "JOKER" : "Joker";
    return `
      <div class="played-card joker ${jokerClass}">
        <div class="card-corner">
          <div class="card-rank" style="font-size:8px">${jokerTop}</div>
        </div>
        <div class="card-center joker-text">${label}王</div>
        <div class="card-corner bottom">
          <div class="card-rank" style="font-size:8px">${jokerTop}</div>
        </div>
      </div>`;
  }

  return `
    <div class="played-card ${colorClass}">
      <div class="card-corner">
        <div class="card-rank">${rankText(card.rank)}</div>
        <div class="card-suit-sm">${suitSymbol(card.suit)}</div>
      </div>
      <div class="card-center">${suitSymbol(card.suit)}</div>
      <div class="card-corner bottom">
        <div class="card-rank">${rankText(card.rank)}</div>
        <div class="card-suit-sm">${suitSymbol(card.suit)}</div>
      </div>
    </div>`;
}

/* ─── Center Table Info ──────────────────────────────────── */
function renderCenter(room) {
  // Score display: show team scores only after friend is revealed
  const friendRevealed = room.friendSeat !== null;
  if (friendRevealed || room.phase === "roundOver") {
    $("#scoreInfo").textContent = `闲家 ${room.scores.attackers} 分 · 庄家队 ${room.scores.dealerTeam} 分`;
  } else {
    $("#scoreInfo").textContent = "";
  }
  $("#turnInfo").textContent = room.turnSeat != null && room.phase === "playing"
    ? `轮到：${seatName(room, room.turnSeat)}`
    : "";

  // Current declared trump ("亮主") shown prominently in the center with a pop
  // animation whenever someone bids / counters (反主/加固).
  renderBidReveal(room);

  // Revealed kitty during auction
  let kittyEl = document.getElementById("revealedKittyDisplay");
  if (!kittyEl) {
    kittyEl = document.createElement("div");
    kittyEl.id = "revealedKittyDisplay";
    kittyEl.style.cssText = "display:flex;gap:4px;flex-wrap:wrap;justify-content:center;margin-top:6px;";
    document.querySelector(".table-center").appendChild(kittyEl);
  }

  if (room.revealedKitty && room.revealedKitty.length > 0 && ["auction","auctionReady","forcedSuit"].includes(room.phase)) {
    kittyEl.innerHTML = room.revealedKitty.map((card) => playedCardHTML(card)).join("");
    kittyEl.style.display = "flex";
  } else {
    kittyEl.innerHTML = "";
    kittyEl.style.display = "none";
  }

  // Throw result display (shown for 2s client-side via CSS animation)
  let throwEl = document.getElementById("throwResultDisplay");
  if (!throwEl) {
    throwEl = document.createElement("div");
    throwEl.id = "throwResultDisplay";
    throwEl.style.cssText = `
      margin-top: 8px;
      display: none;
      flex-direction: column;
      align-items: center;
      gap: 6px;
    `;
    document.querySelector(".table-center").appendChild(throwEl);
  }

  if (room.throwResult) {
    const tr = room.throwResult;
    const allCardsHTML = tr.allCards.map((c) => playedCardHTML(c)).join("");
    const statusColor = tr.failed ? "#ff6b6b" : "#4fc3f7";
    const statusText = tr.failed ? `甩牌失败：${tr.message}` : "甩牌成功";
    throwEl.innerHTML = `
      <div style="display:flex;gap:3px;flex-wrap:wrap;justify-content:center">${allCardsHTML}</div>
      <div style="font-size:12px;color:${statusColor};text-shadow:0 1px 3px rgba(0,0,0,.8)">${statusText}</div>
      ${tr.failed ? `<div style="font-size:11px;color:rgba(255,255,255,.6)">保留：${tr.keepCards.map(c=>c.label).join("、")}</div>` : ""}
    `;
    throwEl.style.display = "flex";
  } else {
    throwEl.innerHTML = "";
    throwEl.style.display = "none";
  }
  let resultEl = document.getElementById("roundResultDisplay");
  if (!resultEl) {
    resultEl = document.createElement("div");
    resultEl.id = "roundResultDisplay";
    resultEl.style.cssText = `
      margin-top: 8px;
      padding: 10px 16px;
      background: rgba(0,0,0,.6);
      border: 1px solid rgba(200,144,45,.5);
      border-radius: 8px;
      color: #e8b84b;
      font-size: 13px;
      text-align: center;
      line-height: 1.7;
    `;
    document.querySelector(".table-center").appendChild(resultEl);
  }

  if (room.phase === "roundOver" && room.lastResult) {
    const r = room.lastResult;
    const lines = [
      `本局闲家得分：${r.attackers} 分`,
      r.buriedBonus > 0 ? `底牌加成：+${r.buriedBonus} 分` : null,
      `结果：${r.result.label}`,
      r.result.steps > 0 && r.upgradedSeats && r.upgradedSeats.length > 0
        ? `升级：${r.upgradedSeats.map((i) => seatName(room, i)).join("、")}`
        : null
    ].filter(Boolean).join("<br>");
    resultEl.innerHTML = lines;
    resultEl.style.display = "block";
  } else {
    resultEl.innerHTML = "";
    resultEl.style.display = "none";
  }
}

/* ─── Center "亮主" reveal ───────────────────────────────── */
function renderBidReveal(room) {
  const el = $("#bidReveal");
  if (!el) return;
  const biddingPhases = ["dealing", "auctionReady", "auction", "forcedSuit"];
  const bid = room.currentBid;
  const cards = bid?.cards || [];

  if (bid && cards.length > 0 && biddingPhases.includes(room.phase)) {
    const who = seatName(room, bid.seat);
    const trumpLabel = bid.noTrump ? "无主" : (bid.trumpSuit ? suitSymbol(bid.trumpSuit) : "");
    const cardsHTML = cards.map((c) => playedCardHTML(c)).join("");
    el.innerHTML = `
      <div class="bid-reveal-label">${who} 亮主${trumpLabel ? " · " + trumpLabel : ""}</div>
      <div class="bid-reveal-cards">${cardsHTML}</div>`;
    el.style.display = "flex";

    const sig = `${bid.seat}|${cards.map((c) => c.id).join(",")}`;
    if (sig !== lastBidSig) {
      el.classList.remove("reveal-pop");
      void el.offsetWidth; // force reflow so the animation restarts
      el.classList.add("reveal-pop");
      lastBidSig = sig;
    }
  } else {
    el.innerHTML = "";
    el.style.display = "none";
    lastBidSig = "";
  }
}

/* ─── Controls ───────────────────────────────────────────── */
function renderControls(room) {
  const parts = [];

  const centerAction = $("#centerAction");
  if (room.phase === "lobby") {
    const allSeated = room.seats.every((s) => s.playerId);
    centerAction.innerHTML = `<button data-action="startRound" ${allSeated ? "" : "disabled"} class="primary-action">开始本局</button>`;
  } else {
    centerAction.innerHTML = "";
  }

  if (["dealing", "auctionReady", "auction"].includes(room.phase)) {
    const myIndex = room.viewerSeat;
    const bidResponses = room.bidResponses || {};
    const myResponse = bidResponses[myIndex];
    const hasBid = !!room.currentBid;
    const revealed = (room.revealedKitty || []).length;
    const allRevealed = revealed >= 7;

    parts.push(`<button data-action="bid">亮庄</button>`);

    if (hasBid && !myResponse && room.currentBid.seat !== myIndex) {
      parts.push(`<button data-action="passBid">不抢</button>`);
    }

    if (room.phase === "auctionReady" && !hasBid) {
      parts.push(`<button data-action="startAuction">开始翻底</button>`);
    }

    if (room.phase === "auction" && !hasBid) {
      if (!allRevealed) {
        parts.push(`<button data-action="revealKitty" class="primary-action">翻下一张 (${revealed}/7)</button>`);
      } else {
        parts.push(`<button data-action="forceDealer" class="primary-action">确认强制坐庄</button>`);
      }
    }
  }

  if (room.phase === "forcedSuit") {
    if (room.viewerSeat === room.dealerSeat) {
      parts.push(`
        <select id="forcedSuit">
          <option value="">不亮，使用底牌花色（${room.trumpSuit ? suitSymbol(room.trumpSuit) : "无主"}）</option>
          <option value="noTrump">亮所选3张王为无主</option>
          <option value="spades">♠ 黑桃</option>
          <option value="hearts">♥ 红桃</option>
          <option value="clubs">♣ 梅花</option>
          <option value="diamonds">♦ 方片</option>
        </select>
        <button data-action="chooseForcedTrump" class="primary-action">确认定主</button>`);
    } else {
      const dealerName = seatName(room, room.dealerSeat);
      parts.push(`<span style="color:rgba(255,255,255,.6);font-size:13px">等待 ${dealerName} 确认主花色…</span>`);
    }
  }

  if (room.phase === "burying" && room.viewerSeat === room.dealerSeat) {
    parts.push(`<button data-action="bury" class="primary-action">扣所选7张</button>`);
  }

  if (room.phase === "friend" && room.viewerSeat === room.dealerSeat) {
    parts.push(friendFormHTML());
  }

  if (room.phase === "playing" && room.viewerSeat === room.turnSeat) {
    parts.push(`<button data-action="play" class="primary-action">出牌 (${state.selected.size}张)</button>`);
  }

  if (room.phase === "roundOver") {
    parts.push(`<button data-action="nextRoundLobby" class="primary-action">回到座位准备下一局</button>`);
  }

  $("#contextControls").innerHTML = parts.join("");
  bindControls();
}

function friendFormHTML() {
  return `
    <select id="friendOrdinal">
      <option value="1">第1张</option>
      <option value="2">第2张</option>
      <option value="3">第3张</option>
    </select>
    <select id="friendSuit">
      <option value="spades">♠ 黑桃</option>
      <option value="hearts">♥ 红桃</option>
      <option value="clubs">♣ 梅花</option>
      <option value="diamonds">♦ 方片</option>
      <option value="joker">王</option>
    </select>
    <select id="friendRank">
      ${["A","K","Q","J","10","9","8","7","6","5","4","3","2","smallJoker","bigJoker"]
        .map((r) => `<option value="${r}">${rankText(r)}</option>`).join("")}
    </select>
    <button data-action="callFriend" class="primary-action">叫朋友</button>`;
}

function bindControls() {
  document.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.action;
      if (action === "bid")         send("bid",         { cardIds: [...state.selected] });
      else if (action === "passBid")     send("passBid",     {});
      else if (action === "forceDealer") send("forceDealer", {});
      else if (action === "bury")        send("bury",        { cardIds: [...state.selected] });
      else if (action === "play")  send("play", { cardIds: [...state.selected] });
      else if (action === "callFriend") {
        send("callFriend", {
          ordinal: Number($("#friendOrdinal").value),
          suit:    $("#friendSuit").value,
          rank:    $("#friendRank").value
        });
      } else if (action === "chooseForcedTrump") {
        const val = $("#forcedSuit").value;
        send("chooseForcedTrump", {
          suit:    val === "noTrump" ? null : (val || null),
          noTrump: val === "noTrump",
          cardIds: [...state.selected]
        });
      } else {
        send(action);
      }
    });
  });
}

/* ─── Hand (fanned, overlapping) ────────────────────────── */
function renderHand(room) {
  const you = room.seats.find((s) => s.isYou);
  const hand = you?.hand || [];

  $("#selectionInfo").textContent = hand.length === 0
    ? ""
    : (state.selected.size > 0 ? `已选 ${state.selected.size} 张` : `手牌 ${hand.length} 张`);

  // Reset the deal-in tracker whenever we're not actively dealing, so the next
  // round's deal animates fresh (and normal play never animates).
  if (room.phase !== "dealing") dealtCardIds.clear();

  const container = $("#hand");
  container.innerHTML = "";
  if (hand.length === 0) {
    // No hand (e.g. lobby): collapse the area so action buttons sit at the
    // bottom instead of being pushed up over a seat.
    container.style.height = "0";
    return;
  }

  const isPortrait = window.innerHeight > window.innerWidth;
  const containerWidth = container.clientWidth || (window.innerWidth - 20);
  const cardW = 52;

  // Portrait narrow screens: split into 2 rows
  if (isPortrait && window.innerWidth < 500 && hand.length > 8) {
    const half = Math.ceil(hand.length / 2);
    const row1 = hand.slice(0, half);
    const row2 = hand.slice(half);
    container.style.height = "160px";
    renderHandRow(container, row1, containerWidth, cardW, 78);  // bottom row
    renderHandRow(container, row2, containerWidth, cardW, 2);   // top row
  } else {
    container.style.height = "86px";
    renderHandRow(container, hand, containerWidth, cardW, 2);
  }
}

function renderHandRow(container, hand, containerWidth, cardW, bottomOffset) {
  const maxOffset = Math.min(38, Math.floor((containerWidth - cardW) / Math.max(hand.length - 1, 1)));
  const totalWidth = cardW + (hand.length - 1) * maxOffset;
  const startX = Math.max(0, (containerWidth - totalWidth) / 2);

  const dealing = state.room?.phase === "dealing";
  hand.forEach((card, i) => {
    const el = document.createElement("button");
    // Only animate cards that are newly dealt this round → no whole-hand flicker.
    const isNewDealt = dealing && !dealtCardIds.has(card.id);
    if (dealing) dealtCardIds.add(card.id);
    el.className = `card ${isRed(card) ? "red" : (card.suit === "joker" ? "joker" : "black")} ${card.rank === "bigJoker" ? "big-joker" : ""} ${isNewDealt ? "dealing-in" : ""}`;
    el.dataset.card = card.id;
    el.title = card.label;

    const selected = state.selected.has(card.id);
    el.style.left   = `${startX + i * maxOffset}px`;
    el.style.bottom = `${bottomOffset}px`;
    el.style.zIndex = selected ? 50 : i + 1;
    if (selected) el.classList.add("selected");

    el.innerHTML = cardFaceHTML(card);
    el.addEventListener("click", () => {
      if (state.selected.has(card.id)) state.selected.delete(card.id);
      else state.selected.add(card.id);
      renderHand(state.room);
      renderControls(state.room);
    });
    container.appendChild(el);
  });
}

/* ─── Card Face HTML ─────────────────────────────────────── */
function cardFaceHTML(card) {
  if (card.rank === "bigJoker") {
    return `
      <div class="card-corner">
        <div class="card-rank" style="font-size:9px;color:#b8860b">JOKER</div>
      </div>
      <div class="card-center" style="font-size:13px;font-weight:900;color:#b8860b">大王</div>
      <div class="card-corner bottom">
        <div class="card-rank" style="font-size:9px;color:#b8860b">JOKER</div>
      </div>`;
  }
  if (card.rank === "smallJoker") {
    return `
      <div class="card-corner">
        <div class="card-rank" style="font-size:9px;color:#5c3a00">Joker</div>
      </div>
      <div class="card-center" style="font-size:13px;font-weight:900;color:#5c3a00">小王</div>
      <div class="card-corner bottom">
        <div class="card-rank" style="font-size:9px;color:#5c3a00">Joker</div>
      </div>`;
  }
  return `
    <div class="card-corner">
      <div class="card-rank">${rankText(card.rank)}</div>
      <div class="card-suit-sm">${suitSymbol(card.suit)}</div>
    </div>
    <div class="card-center">${suitSymbol(card.suit)}</div>
    <div class="card-corner bottom">
      <div class="card-rank">${rankText(card.rank)}</div>
      <div class="card-suit-sm">${suitSymbol(card.suit)}</div>
    </div>`;
}

/* ─── Log ────────────────────────────────────────────────── */
function renderLog(room) {
  $("#log").innerHTML = room.tableLog.slice().reverse()
    .map((line) => `<div>${line}</div>`).join("");
}

// Log drawer toggle
$("#logToggle").addEventListener("click", () => {
  $("#logPanel").classList.toggle("open");
});

// Re-render on orientation change so layout updates immediately
window.addEventListener("orientationchange", () => {
  setTimeout(() => { if (state.room) render(); }, 150);
});
window.addEventListener("resize", () => {
  if (state.room) renderHand(state.room);
});

// ─── Auto-reconnect after the app is backgrounded / loses the socket ──────────
// On mobile, switching away can suspend or kill the WebSocket; on return the UI
// looks frozen. Re-open the connection (the server re-seats us via our playerId).
function reconnectIfNeeded() {
  if (!state.room?.code) return;
  const ws = state.ws;
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  connectAndJoin(state.room.code, state.nickname);
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") reconnectIfNeeded();
});
window.addEventListener("pageshow", reconnectIfNeeded);
window.addEventListener("focus", reconnectIfNeeded);
window.addEventListener("online", reconnectIfNeeded);

// Fullscreen toggle (works on Android; Safari requires Add to Home Screen)
const fullscreenBtn = document.getElementById("fullscreenBtn");
if (fullscreenBtn) {
  fullscreenBtn.addEventListener("click", () => {
    const el = document.documentElement;
    if (!document.fullscreenElement) {
      (el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen
        || (() => {})).call(el);
      fullscreenBtn.textContent = "✕";
    } else {
      (document.exitFullscreen || document.webkitExitFullscreen
        || (() => {})).call(document);
      fullscreenBtn.textContent = "⛶";
    }
  });
  document.addEventListener("fullscreenchange", () => {
    fullscreenBtn.textContent = document.fullscreenElement ? "✕" : "⛶";
  });
}

/* ─── Error ──────────────────────────────────────────────── */
function showError(msg) {
  const box = $("#errorBox");
  box.textContent = msg;
  setTimeout(() => { if (box.textContent === msg) box.textContent = ""; }, 3500);
}

/* ─── Helpers ────────────────────────────────────────────── */
function phaseText(phase) {
  return {
    lobby:       "等待入座",
    dealing:     "摸牌抢庄",
    auctionReady:"等待翻底",
    auction:     "翻底拍卖",
    forcedSuit:  "强制定主",
    burying:     "庄家扣底",
    friend:      "叫朋友",
    playing:     "出牌中",
    roundOver:   "本局结束"
  }[phase] || phase;
}

function seatName(room, index) {
  return room.seats[index]?.nickname || `座位${index + 1}`;
}

function suitSymbol(suit) {
  return { spades: "♠", hearts: "♥", clubs: "♣", diamonds: "♦" }[suit] || "";
}

function isRed(card) {
  return card.suit === "hearts" || card.suit === "diamonds";
}

function rankText(rank) {
  if (rank === "smallJoker") return "小王";
  if (rank === "bigJoker")   return "大王";
  return rank;
}
