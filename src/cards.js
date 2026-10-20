import { randomInt } from 'node:crypto';

const RANKS = '23456789TJQKA';
const SUITS = 'shdc';

export const HAND_NAMES = ['高牌', '一對', '兩對', '三條', '順子', '同花', '葫蘆', '四條', '同花順'];

export function rankOf(card) {
  return RANKS.indexOf(card[0]) + 2;
}

export function newDeck() {
  const deck = [];
  for (const r of RANKS) for (const s of SUITS) deck.push(r + s);
  // Fisher-Yates with a CSPRNG so the deal cannot be predicted.
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function pack(cat, kickers) {
  let v = cat;
  for (let i = 0; i < 5; i++) v = v * 15 + (kickers[i] || 0);
  return v;
}

function score5(cards) {
  const rs = cards.map(rankOf).sort((a, b) => b - a);
  const flush = cards.every((c) => c[1] === cards[0][1]);
  let straightHigh = 0;
  if (new Set(rs).size === 5) {
    if (rs[0] - rs[4] === 4) straightHigh = rs[0];
    else if (rs[0] === 14 && rs[1] === 5) straightHigh = 5; // A-2-3-4-5
  }
  const counts = new Map();
  for (const r of rs) counts.set(r, (counts.get(r) || 0) + 1);
  const groups = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const ordered = groups.map((g) => g[0]);

  let cat;
  let ranks = ordered;
  if (straightHigh && flush) { cat = 8; ranks = [straightHigh]; }
  else if (groups[0][1] === 4) cat = 7;
  else if (groups[0][1] === 3 && groups[1][1] === 2) cat = 6;
  else if (flush) { cat = 5; ranks = rs; }
  else if (straightHigh) { cat = 4; ranks = [straightHigh]; }
  else if (groups[0][1] === 3) cat = 3;
  else if (groups[0][1] === 2 && groups[1][1] === 2) cat = 2;
  else if (groups[0][1] === 2) cat = 1;
  else cat = 0;
  return { score: pack(cat, ranks), cat, ranks };
}

// Best 5-card hand out of 5–7 cards.
export function evaluate(cards) {
  let best = null;
  const n = cards.length;
  const consider = (five) => {
    const s = score5(five);
    if (!best || s.score > best.score) best = { ...s, cards: five };
  };
  if (n === 5) consider(cards);
  else {
    // Choose the 5 cards by leaving out (n - 5) of them.
    const skip = n - 5;
    const idx = [...Array(skip).keys()];
    for (;;) {
      consider(cards.filter((_, i) => !idx.includes(i)));
      let k = skip - 1;
      while (k >= 0 && idx[k] === n - skip + k) k--;
      if (k < 0) break;
      idx[k]++;
      for (let m = k + 1; m < skip; m++) idx[m] = idx[m - 1] + 1;
    }
  }
  best.name = best.cat === 8 && best.ranks[0] === 14 ? '皇家同花順' : HAND_NAMES[best.cat];
  return best;
}
