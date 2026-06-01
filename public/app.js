const state = {
  ws: null,
  playerId: localStorage.getItem("szp.playerId") || "",
  nickname: localStorage.getItem("szp.nickname") || "",
  room: null,
  selected: new Set()
};

const $ = (selector) => document.querySelector(selector);
const views = {
  join: document.querySelector('[data-view="join"]'),
  game: document.querySelector('[data-view="game"]')
};

$("#nickname").value = state.nickname;

$("#joinForm").addEventListener("submit", (event) => {
  event.preventDefault();
  connectAndJoin($("#roomCode").value.trim(), $("#nickname").value.trim());
});

$("#createRoom").addEventListener("click", () => {
  connectAndJoin("", $("#nickname").value.trim());
});

function connectAndJoin(code, nickname) {
  state.nickname = nickname || "玩家";
  localStorage.setItem("szp.nickname", state.nickname);
  state.ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`);
  state.ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "hello") {
      state.playerId = message.payload.playerId;
      localStorage.setItem("szp.playerId", state.playerId);
      send(code ? "joinRoom" : "createRoom", { code, nickname: state.nickname });
    }
    if (message.type === "state") {
      state.room = message.payload;
      state.selected.clear();
      render();
    }
    if (message.type === "error") showError(message.payload.message);
  });
}

function send(type, payload = {}) {
  state.ws?.send(JSON.stringify({ type, payload }));
}

function render() {
  views.join.classList.add("hidden");
  views.game.classList.remove("hidden");
  const room = state.room;
  $("#roomBadge").textContent = `房间 ${room.code}`;
  $("#phaseBadge").textContent = phaseText(room.phase);
  renderSeats(room);
  renderTable(room);
  renderControls(room);
  renderHand(room);
  renderLog(room);
}

function renderSeats(room) {
  $("#seats").innerHTML = room.seats.map((seat) => `
    <div class="seat seat-${seat.index} ${seat.isYou ? "you" : ""}">
      <strong>${seat.nickname || `座位 ${seat.index + 1}`}</strong>
      <span>${seat.playerId ? `${seat.isAi ? "电脑" : (seat.connected ? "在线" : "离线")} · ${seat.handCount} 张` : "空座"}</span>
      <span>等级：${seat.level || "-"}</span>
      <span>个人墩分：${seat.takenTrickPoints}</span>
      ${!seat.playerId && room.phase === "lobby" ? `<button data-sit="${seat.index}">坐下</button><button data-ai="${seat.index}">加 AI</button>` : ""}
      ${seat.isYou && room.phase === "lobby" ? `<button data-leave>离座</button>` : ""}
    </div>
  `).join("");
  document.querySelectorAll("[data-sit]").forEach((button) => {
    button.addEventListener("click", () => send("sit", { seatIndex: Number(button.dataset.sit), nickname: state.nickname }));
  });
  document.querySelectorAll("[data-ai]").forEach((button) => {
    button.addEventListener("click", () => send("addAi", { seatIndex: Number(button.dataset.ai) }));
  });
  document.querySelectorAll("[data-leave]").forEach((button) => {
    button.addEventListener("click", () => send("leaveSeat"));
  });
}

function renderTable(room) {
  const trump = room.noTrump ? "无主" : (room.trumpSuit || "-");
  $("#roundInfo").textContent = `第 ${room.round || 0} 局 · 打 ${room.levelRank || "-"} · 主 ${trump}`;
  $("#scoreInfo").textContent = `闲家 ${room.scores.attackers} 分 · 庄家队 ${room.scores.dealerTeam} 分`;
  $("#turnInfo").textContent = room.turnSeat == null ? "" : `轮到：${seatName(room, room.turnSeat)}`;
  $("#trick").innerHTML = room.currentTrick.map((play) => `
    <div class="played">
      <strong>${seatName(room, play.seat)}</strong>
      <div>${play.cards.map(cardLabel).join(" ")}</div>
    </div>
  `).join("");
}

function renderControls(room) {
  const controls = [];
  if (room.phase === "lobby") {
    controls.push(`<button data-action="startRound" ${room.seats.some((seat) => !seat.playerId) ? "disabled" : ""}>开始本局</button>`);
  }
  if (["dealing", "auctionReady", "auction"].includes(room.phase)) {
    controls.push(`<button data-action="bid">用所选牌抢庄</button>`);
    if (room.currentBid) controls.push(`<button data-action="confirmDealer">确认庄家</button>`);
    if (room.phase === "auctionReady" && !room.currentBid) controls.push(`<button data-action="startAuction">开始翻底拍卖</button>`);
    if (room.phase === "auction") controls.push(`<button data-action="revealKitty">翻一张底牌</button>`);
  }
  if (room.phase === "forcedSuit" && room.viewerSeat === room.dealerSeat) {
    controls.push(`
      <select id="forcedSuit">
        <option value="">不亮，使用最后底牌花色</option>
        <option value="noTrump">亮所选 3 张王为无主</option>
        <option value="spades">黑桃</option>
        <option value="hearts">红桃</option>
        <option value="clubs">梅花</option>
        <option value="diamonds">方片</option>
      </select>
      <button data-action="chooseForcedTrump">定主并拿底</button>
    `);
  }
  if (room.phase === "burying" && room.viewerSeat === room.dealerSeat) {
    controls.push(`<button data-action="bury">扣所选 7 张</button>`);
  }
  if (room.phase === "friend" && room.viewerSeat === room.dealerSeat) {
    controls.push(friendForm());
  }
  if (room.phase === "playing" && room.viewerSeat === room.turnSeat) {
    controls.push(`<button data-action="play">出所选牌</button>`);
  }
  if (room.phase === "roundOver") {
    controls.push(`<button data-action="nextRoundLobby">回到座位准备下一局</button>`);
  }
  $("#contextControls").innerHTML = controls.join("");
  bindControls();
}

function friendForm() {
  return `
    <select id="friendOrdinal">
      <option value="1">第 1 张</option>
      <option value="2">第 2 张</option>
      <option value="3">第 3 张</option>
    </select>
    <select id="friendSuit">
      <option value="spades">黑桃</option>
      <option value="hearts">红桃</option>
      <option value="clubs">梅花</option>
      <option value="diamonds">方片</option>
      <option value="joker">王</option>
    </select>
    <select id="friendRank">
      ${["A","K","Q","J","10","9","8","7","6","5","4","3","2","smallJoker","bigJoker"].map((rank) => `<option value="${rank}">${rankText(rank)}</option>`).join("")}
    </select>
    <button data-action="callFriend">叫朋友</button>
  `;
}

function bindControls() {
  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.action;
      if (action === "bid") send("bid", { cardIds: [...state.selected] });
      else if (action === "bury") send("bury", { cardIds: [...state.selected] });
      else if (action === "play") send("play", { cardIds: [...state.selected] });
      else if (action === "callFriend") {
        send("callFriend", {
          ordinal: Number($("#friendOrdinal").value),
          suit: $("#friendSuit").value,
          rank: $("#friendRank").value
        });
      } else if (action === "chooseForcedTrump") {
        const value = $("#forcedSuit").value;
        send("chooseForcedTrump", {
          suit: value === "noTrump" ? null : value || null,
          noTrump: value === "noTrump",
          cardIds: [...state.selected]
        });
      } else {
        send(action);
      }
    });
  });
}

function renderHand(room) {
  const you = room.seats.find((seat) => seat.isYou);
  const hand = you?.hand || [];
  $("#selectionInfo").textContent = `已选 ${state.selected.size} 张`;
  $("#hand").innerHTML = hand.map((card) => `
    <button class="card ${isRed(card) ? "red" : ""} ${card.suit === "joker" ? "joker" : ""} ${state.selected.has(card.id) ? "selected" : ""}" data-card="${card.id}" title="${cardLabel(card)}">
      ${cardFace(card)}
    </button>
  `).join("");
  document.querySelectorAll("[data-card]").forEach((cardButton) => {
    cardButton.addEventListener("click", () => {
      const id = cardButton.dataset.card;
      if (state.selected.has(id)) state.selected.delete(id);
      else state.selected.add(id);
      renderHand(state.room);
      renderControls(state.room);
    });
  });
}

function renderLog(room) {
  $("#log").innerHTML = room.tableLog.slice().reverse().map((line) => `<div>${line}</div>`).join("");
}

function showError(message) {
  $("#errorBox").textContent = message;
  setTimeout(() => {
    if ($("#errorBox").textContent === message) $("#errorBox").textContent = "";
  }, 3500);
}

function phaseText(phase) {
  return {
    lobby: "等待入座",
    dealing: "摸牌抢庄",
    auctionReady: "等待翻底",
    auction: "翻底拍卖",
    forcedSuit: "强制定主",
    burying: "庄家扣底",
    friend: "叫朋友",
    playing: "出牌中",
    roundOver: "本局结束"
  }[phase] || phase;
}

function seatName(room, index) {
  return room.seats[index]?.nickname || `座位 ${index + 1}`;
}

function cardLabel(card) {
  return card.label;
}

function cardFace(card) {
  if (card.rank === "bigJoker") return `<span class="corner">JOKER</span><span class="pip">大</span><span class="corner bottom">JOKER</span>`;
  if (card.rank === "smallJoker") return `<span class="corner">Joker</span><span class="pip">小</span><span class="corner bottom">Joker</span>`;
  return `
    <span class="corner">${rankText(card.rank)}${suitSymbol(card.suit)}</span>
    <span class="pip">${suitSymbol(card.suit)}</span>
    <span class="corner bottom">${rankText(card.rank)}${suitSymbol(card.suit)}</span>
  `;
}

function suitSymbol(suit) {
  return {
    spades: "♠",
    hearts: "♥",
    clubs: "♣",
    diamonds: "♦"
  }[suit] || "";
}

function isRed(card) {
  return card.suit === "hearts" || card.suit === "diamonds";
}

function rankText(rank) {
  if (rank === "smallJoker") return "小王";
  if (rank === "bigJoker") return "大王";
  return rank;
}
