import { randomInt } from 'node:crypto';
import { evaluate, rankOf } from './cards.js';

// Hard-coded personalities. Thresholds are compared with a 0–1 hand strength.
//   callT  – preflop strength needed to call
//   raiseT – preflop strength needed to raise
//   aggr   – how often a good hand bets/raises instead of checking/calling
//   bluff  – chance of betting with nothing
//   sticky – willingness to call with marginal hands (calling station-ness)
export const STYLES = [
  { key: 'tag', label: '緊凶', callT: 0.58, raiseT: 0.72, aggr: 0.7, bluff: 0.04, sticky: 0.1 },
  { key: 'loose', label: '鬆弱', callT: 0.36, raiseT: 0.8, aggr: 0.3, bluff: 0.04, sticky: 0.35 },
  { key: 'maniac', label: '瘋狂', callT: 0.38, raiseT: 0.55, aggr: 0.85, bluff: 0.18, sticky: 0.2 },
  { key: 'station', label: '跟注站', callT: 0.3, raiseT: 0.88, aggr: 0.15, bluff: 0, sticky: 0.6 },
  { key: 'rock', label: '岩石', callT: 0.66, raiseT: 0.8, aggr: 0.5, bluff: 0.01, sticky: 0.05 },
];

const NAMES = [
  '阿明', '小美', '老王', '莉莉', '大雄', '阿傑', '小芳', '志豪', '雅婷', '建國',
  '阿花', '胖虎', '小傑', '美玲', '阿德', '靜香', '老李', '阿寶', '小龍', '佩琪',
];

export function makeBot(seat, stack, takenNames, style) {
  const free = NAMES.filter((n) => !takenNames.has(n));
  const name = free.length ? free[randomInt(free.length)] : `Bot${seat}`;
  return { seat, name, human: false, style: style ?? STYLES[randomInt(STYLES.length)], stack };
}

export function preflopStrength([a, b]) {
  const r1 = rankOf(a);
  const r2 = rankOf(b);
  const hi = Math.max(r1, r2);
  const lo = Math.min(r1, r2);
  if (hi === lo) return 0.5 + ((hi - 2) / 12) * 0.5; // 22 = 0.50 … AA = 1.00
  let s = ((hi - 2) / 12) * 0.45 + ((lo - 2) / 12) * 0.25;
  if (a[1] === b[1]) s += 0.07;
  const gap = hi - lo - 1;
  if (gap === 0) s += 0.05;
  else if (gap === 1) s += 0.03;
  else if (gap >= 4) s -= 0.05;
  if (lo >= 10) s += 0.06;
  return s;
}

function groupCat(cards) {
  const counts = new Map();
  for (const c of cards) counts.set(rankOf(c), (counts.get(rankOf(c)) || 0) + 1);
  const g = [...counts.values()].sort((x, y) => y - x);
  if (g[0] >= 4) return 7;
  if (g[0] === 3) return 3;
  if (g[0] === 2 && g[1] === 2) return 2;
  if (g[0] === 2) return 1;
  return 0;
}

function drawEquity(hole, board) {
  if (board.length >= 5) return 0;
  const all = [...hole, ...board];
  let eq = 0;
  for (const suit of 'shdc') {
    const n = all.filter((c) => c[1] === suit).length;
    if (n === 4 && hole.some((c) => c[1] === suit)) eq = 0.35;
  }
  const ranks = new Set(all.map(rankOf));
  if (ranks.has(14)) ranks.add(1);
  const holeRanks = hole.map(rankOf);
  for (let low = 1; low <= 10; low++) {
    let have = 0;
    let usesHole = false;
    for (let r = low; r < low + 5; r++) {
      if (ranks.has(r)) {
        have++;
        if (holeRanks.includes(r) || (r === 1 && holeRanks.includes(14))) usesHole = true;
      }
    }
    if (have === 4 && usesHole) eq = Math.max(eq, 0.25);
  }
  return board.length === 4 ? eq / 2 : eq;
}

// Rough 0–1 strength of a made hand after the flop, discounting what the board gives everyone.
export function postflopStrength(hole, board) {
  const ev = evaluate([...hole, ...board]);
  const boardCat = board.length >= 5 ? evaluate(board).cat : groupCat(board);
  if (board.length === 5 && evaluate(board).score === ev.score) return { s: 0.2, draw: 0 };

  const boardRanks = board.map(rankOf).sort((x, y) => y - x);
  const holeRanks = hole.map(rankOf);
  const draw = drawEquity(hole, board);
  let s;
  if (ev.cat >= 4) s = 0.85 + ev.cat * 0.015;
  else if (ev.cat === 3) s = boardCat === 3 ? 0.35 : 0.82;
  else if (ev.cat === 2) s = boardCat === 2 ? 0.3 : boardCat === 1 ? 0.62 : 0.8;
  else if (ev.cat === 1 && boardCat === 0) {
    const pair = ev.ranks[0];
    const kicker = Math.max(...holeRanks.filter((r) => r !== pair), 0);
    if (holeRanks[0] === holeRanks[1] && pair > boardRanks[0]) s = 0.72;
    else if (pair >= boardRanks[0]) s = 0.6 + (kicker >= 11 ? 0.08 : 0);
    else if (pair >= boardRanks[1]) s = 0.48;
    else s = 0.42;
  } else {
    s = 0.15 + (holeRanks.includes(14) ? 0.05 : 0);
  }
  return { s, draw };
}

export function decide(t, p, bigBlind) {
  const st = p.style;
  const rnd = Math.random;
  const toCall = Math.min(t.currentBet - p.bet, p.stack);
  const pot = t.potTotal();
  const { minTo, maxTo } = t.raiseBounds(p);
  const canRaise = maxTo > t.currentBet;

  const check = () => ({ action: 'check' });
  const call = () => (toCall > 0 ? { action: 'call' } : check());
  const fold = () => (toCall > 0 ? { action: 'fold' } : check());
  const raiseTo = (to) => {
    if (!canRaise) return call();
    const amount = Math.max(minTo, Math.min(maxTo, Math.round(to / 10) * 10));
    return { action: 'raise', amount };
  };

  if (t.street === 'preflop') {
    const s = preflopStrength(p.hole) + (rnd() - 0.5) * 0.08;
    const facingRaise = t.currentBet > bigBlind;
    const priceRatio = toCall / (p.stack + p.bet);
    if (s >= st.raiseT + (facingRaise ? 0.1 : 0) && rnd() < 0.5 + st.aggr * 0.5) {
      const limpers = t.seats.filter((q) => q.inHand && q !== p && q.bet === bigBlind).length;
      return raiseTo(facingRaise ? t.currentBet * 3 : bigBlind * (2 + limpers));
    }
    if (toCall === 0) return check();
    const need = st.callT + (facingRaise ? 0.12 : 0)
      + (priceRatio > 0.3 ? 0.2 : priceRatio > 0.12 ? 0.1 : 0) - st.sticky * 0.1;
    if (s >= need) return call();
    if (!facingRaise && rnd() < st.bluff) return raiseTo(bigBlind * 3);
    return fold();
  }

  const { s, draw } = postflopStrength(p.hole, t.board);
  const potOdds = toCall / (pot + toCall);
  const r = rnd();
  if (s >= 0.78) {
    if (toCall === 0) return r < 0.55 + st.aggr * 0.4 ? raiseTo(pot * (0.55 + r * 0.25)) : check();
    return r < st.aggr * 0.6 ? raiseTo(t.currentBet * 2.5 + pot * 0.3) : call();
  }
  if (s >= 0.6) {
    if (toCall === 0) return r < st.aggr * 0.75 ? raiseTo(pot * 0.5) : check();
    return potOdds <= 0.4 + st.sticky * 0.3 ? call() : fold();
  }
  if (s >= 0.42) {
    if (toCall === 0) return r < st.aggr * 0.25 ? raiseTo(pot * 0.4) : check();
    return potOdds <= 0.25 + st.sticky * 0.3 ? call() : fold();
  }
  if (draw > 0) {
    if (toCall === 0) return r < st.aggr * 0.35 ? raiseTo(pot * 0.5) : check();
    return potOdds <= draw + st.sticky * 0.1 ? call() : fold();
  }
  if (toCall === 0) return r < st.bluff * 2 ? raiseTo(pot * 0.5) : check();
  return r < st.sticky * 0.15 && potOdds < 0.25 ? call() : fold();
}
