export const SUITS = ["spades", "hearts", "clubs", "diamonds"];
export const SUIT_LABELS = {
  spades: "黑桃",
  hearts: "红桃",
  clubs: "梅花",
  diamonds: "方片"
};
export const RANKS = ["A", "K", "Q", "J", "10", "9", "8", "7", "6", "5", "4", "3", "2"];
export const LEVEL_RANKS = ["A", "K", "Q", "J", "10", "9", "8", "7", "6", "5", "4", "3", "2"];
export const JOKERS = ["smallJoker", "bigJoker"];

export function createDeck() {
  const deck = [];
  let id = 1;
  for (let copy = 1; copy <= 3; copy += 1) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        deck.push({ id: `c${id}`, copy, suit, rank, label: `${SUIT_LABELS[suit]}${rank}` });
        id += 1;
      }
    }
    deck.push({ id: `c${id}`, copy, suit: "joker", rank: "smallJoker", label: "小王" });
    id += 1;
    deck.push({ id: `c${id}`, copy, suit: "joker", rank: "bigJoker", label: "大王" });
    id += 1;
  }
  return deck;
}

export function shuffle(cards, random = Math.random) {
  const out = [...cards];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function cardScore(card) {
  if (card.rank === "5") return 5;
  if (card.rank === "10" || card.rank === "K") return 10;
  return 0;
}

export function cardName(card) {
  return card?.label ?? "";
}

export function levelAdvance(rank, steps) {
  const index = LEVEL_RANKS.indexOf(rank);
  if (index < 0) return rank;
  // LEVEL_RANKS = ["A","K","Q","J","10","9","8","7","6","5","4","3","2"]
  // index 0=A (highest), 12=2 (lowest).
  // Upgrading = moving toward A (decreasing index), cycling: after A comes 2.
  const newIndex = ((index - steps) % LEVEL_RANKS.length + LEVEL_RANKS.length) % LEVEL_RANKS.length;
  return LEVEL_RANKS[newIndex];
}

export function rankNumber(rank) {
  if (rank === "A") return 14;
  if (rank === "K") return 13;
  if (rank === "Q") return 12;
  if (rank === "J") return 11;
  if (rank === "10") return 10;
  return Number(rank);
}
