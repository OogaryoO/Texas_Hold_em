import { randomInt } from 'node:crypto';
import { newDeck, evaluate } from './cards.js';
import { STYLES, makeBot, decide } from './bots.js';

export const SMALL_BLIND = 10;
export const BIG_BLIND = 20;
export const BOT_STACK = 2000;
const SEATS = 6;
const MAX_FRAMES = 300;

export class GameError extends Error {}

// One table per logged-in player: seat 0 is the human, seats 1–5 are bots.
// The server is authoritative; the client only replays the frames it logs.
export class Table {
  constructor(user) {
    this.userId = user.id;
    this.seq = 0;
    this.frames = [];
    this.handNo = 0;
    this.dealer = randomInt(SEATS);
    this.inHand = false;
    this.street = 'idle';
    this.board = [];
    this.currentBet = 0;
    this.minRaise = BIG_BLIND;
    this.toAct = -1;
    this.sb = -1;
    this.bb = -1;
    this.lastResult = null;
    this.pendingResult = null;
    this.lastActive = Date.now();

    const styles = [...STYLES].sort(() => Math.random() - 0.5);
    this.seats = [{ seat: 0, name: user.username, human: true, style: null, stack: user.chips }];
    const taken = new Set([user.username]);
    for (let i = 1; i < SEATS; i++) {
      const bot = makeBot(i, BOT_STACK, taken, styles[i - 1]);
      taken.add(bot.name);
      this.seats.push(bot);
    }
    for (const p of this.seats) resetForHand(p);
    this.log('入座完成，按「發牌」開始');
  }

  get human() {
    return this.seats[0];
  }

  next(from, pred) {
    for (let k = 1; k <= SEATS; k++) {
      const i = (from + k) % SEATS;
      if (pred(this.seats[i])) return i;
    }
    return -1;
  }

  potTotal() {
    return this.seats.reduce((sum, p) => sum + p.total, 0);
  }

  raiseBounds(p) {
    const maxTo = p.bet + p.stack;
    return { minTo: Math.min(this.currentBet + this.minRaise, maxTo), maxTo };
  }

  startHand() {
    if (this.inHand) throw new GameError('這一手還沒結束');
    if (this.human.stack <= 0) throw new GameError('籌碼不足，請先領取救濟金');

    const taken = new Set(this.seats.map((p) => p.name));
    for (let i = 1; i < SEATS; i++) {
      if (this.seats[i].stack < BIG_BLIND) {
        const old = this.seats[i].name;
        taken.delete(old);
        // Prefer a personality that is not at the table, so it stays varied.
        const present = new Set(this.seats.map((p) => p.style));
        const missing = STYLES.filter((st) => !present.has(st));
        const style = missing.length ? missing[randomInt(missing.length)] : undefined;
        this.seats[i] = makeBot(i, BOT_STACK, taken, style);
        resetForHand(this.seats[i]);
        taken.add(this.seats[i].name);
        this.log(`${old} 輸光離桌，${this.seats[i].name}（${this.seats[i].style.label}）入座`);
      }
    }

    this.handNo++;
    for (const p of this.seats) {
      resetForHand(p);
      p.inHand = p.stack > 0;
    }
    this.board = [];
    this.lastResult = null;
    this.pendingResult = null;
    this.deck = newDeck();
    this.dealer = this.next(this.dealer, (p) => p.inHand);
    const inHand = this.seats.filter((p) => p.inHand).length;
    // Heads-up: the dealer posts the small blind.
    this.sb = inHand === 2 ? this.dealer : this.next(this.dealer, (p) => p.inHand);
    this.bb = this.next(this.sb, (p) => p.inHand);
    this.put(this.seats[this.sb], Math.min(SMALL_BLIND, this.seats[this.sb].stack));
    this.put(this.seats[this.bb], Math.min(BIG_BLIND, this.seats[this.bb].stack));
    this.seats[this.sb].lastAction = '小盲';
    this.seats[this.bb].lastAction = '大盲';
    for (let round = 0; round < 2; round++) {
      for (const p of this.seats) if (p.inHand) p.hole.push(this.deck.pop());
    }
    this.street = 'preflop';
    this.currentBet = BIG_BLIND;
    this.minRaise = BIG_BLIND;
    this.inHand = true;
    this.toAct = this.next(this.bb, canAct);
    this.log(`第 ${this.handNo} 手開始，盲注 ${SMALL_BLIND}/${BIG_BLIND}`);
    this.run();
  }

  humanAction(action, amount) {
    if (!this.inHand || this.toAct !== 0) throw new GameError('還沒輪到你');
    this.apply(this.human, action, amount, true);
    this.run();
  }

  // Advance bots until it is the human's turn or the hand is over.
  run() {
    while (this.inHand) {
      const live = this.seats.filter((p) => p.inHand && !p.folded);
      if (live.length === 1) {
        this.finishUncontested(live[0]);
        return;
      }
      if (this.roundDone()) {
        this.nextStreet();
        continue;
      }
      const p = this.seats[this.toAct];
      if (p.human) return;
      const d = decide(this, p, BIG_BLIND);
      this.apply(p, d.action, d.amount, false);
    }
  }

  roundDone() {
    const actors = this.seats.filter(canAct);
    if (actors.length === 0) return true;
    if (actors.length === 1 && actors[0].bet >= this.currentBet) return true;
    return actors.every((p) => p.acted && p.bet === this.currentBet);
  }

  put(p, amount) {
    p.stack -= amount;
    p.bet += amount;
    p.total += amount;
    if (p.stack === 0) p.allIn = true;
  }

  apply(p, action, amount, strict) {
    const toCall = this.currentBet - p.bet;
    switch (action) {
      case 'fold':
        p.folded = true;
        p.lastAction = '棄牌';
        break;
      case 'check':
        if (toCall > 0) {
          if (strict) throw new GameError('目前不能過牌');
          p.folded = true;
          p.lastAction = '棄牌';
          break;
        }
        p.lastAction = '過牌';
        break;
      case 'call': {
        if (toCall <= 0) {
          p.lastAction = '過牌';
          break;
        }
        this.put(p, Math.min(toCall, p.stack));
        p.lastAction = p.allIn ? `全下 ${p.bet}` : `跟注 ${p.bet}`;
        break;
      }
      case 'raise': {
        const { minTo, maxTo } = this.raiseBounds(p);
        if (maxTo <= this.currentBet) {
          if (strict) throw new GameError('籌碼不足以加注');
          return this.apply(p, 'call', 0, false);
        }
        let to = Math.floor(Number(amount));
        if (!Number.isFinite(to)) throw new GameError('加注金額無效');
        if (strict && (to < minTo || to > maxTo)) {
          throw new GameError(`加注金額需介於 ${minTo} 與 ${maxTo} 之間`);
        }
        to = Math.max(minTo, Math.min(maxTo, to));
        const wasBet = this.currentBet === 0;
        const raiseBy = to - this.currentBet;
        this.put(p, to - p.bet);
        if (raiseBy >= this.minRaise) this.minRaise = raiseBy;
        this.currentBet = to;
        for (const q of this.seats) if (q !== p && canAct(q)) q.acted = false;
        p.lastAction = p.allIn ? `全下 ${to}` : wasBet ? `下注 ${to}` : `加注到 ${to}`;
        break;
      }
      default:
        throw new GameError('未知的動作');
    }
    p.acted = true;
    this.log(`${p.name} ${p.lastAction}`);
    this.toAct = this.next(p.seat, canAct);
  }

  nextStreet() {
    if (this.street === 'river') {
      this.showdown();
      return;
    }
    for (const p of this.seats) {
      p.bet = 0;
      p.acted = false;
      if (p.inHand && !p.folded && !p.allIn) p.lastAction = '';
    }
    this.currentBet = 0;
    this.minRaise = BIG_BLIND;
    this.deck.pop(); // burn
    if (this.street === 'preflop') {
      this.board.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
      this.street = 'flop';
      this.log('翻牌');
    } else if (this.street === 'flop') {
      this.board.push(this.deck.pop());
      this.street = 'turn';
      this.log('轉牌');
    } else {
      this.board.push(this.deck.pop());
      this.street = 'river';
      this.log('河牌');
    }
    this.toAct = this.next(this.dealer, canAct);
  }

  // Return the part of the largest contribution that nobody matched.
  refundUncalled() {
    const sorted = [...this.seats].sort((a, b) => b.total - a.total);
    const [top, second] = sorted;
    if (top.total > second.total) {
      const diff = top.total - second.total;
      top.total -= diff;
      top.stack += diff;
      if (top.stack > 0) top.allIn = false;
    }
  }

  finishUncontested(winner) {
    this.refundUncalled();
    const pot = this.potTotal();
    winner.stack += pot;
    winner.won = pot;
    this.log(`${winner.name} 贏得底池 ${pot}`);
    this.endHand([{ seat: winner.seat, name: winner.name, amount: pot, hand: null }], pot);
  }

  showdown() {
    this.street = 'showdown';
    this.refundUncalled();
    const live = this.seats.filter((p) => p.inHand && !p.folded);
    for (const p of live) {
      p.hand = evaluate([...p.hole, ...this.board]);
      p.revealed = true;
    }
    const totalPot = this.potTotal();

    const pots = [];
    let prev = 0;
    const levels = [...new Set(live.map((p) => p.total))].sort((a, b) => a - b);
    for (const level of levels) {
      const amount = this.seats.reduce((s, p) => s + Math.max(0, Math.min(p.total, level) - prev), 0);
      pots.push({ amount, eligible: live.filter((p) => p.total >= level) });
      prev = level;
    }
    // Chips folded players put in above the highest live contribution.
    pots[pots.length - 1].amount += this.seats.reduce((s, p) => s + Math.max(0, p.total - prev), 0);

    // Odd chips go to the first winner left of the dealer.
    const order = (p) => (p.seat - this.dealer + SEATS - 1) % SEATS;
    for (const pot of pots) {
      if (pot.amount === 0) continue;
      const best = Math.max(...pot.eligible.map((p) => p.hand.score));
      const winners = pot.eligible.filter((p) => p.hand.score === best).sort((a, b) => order(a) - order(b));
      const share = Math.floor(pot.amount / winners.length);
      let odd = pot.amount - share * winners.length;
      for (const w of winners) {
        const amt = share + (odd > 0 ? 1 : 0);
        if (odd > 0) odd--;
        w.stack += amt;
        w.won += amt;
      }
    }
    const results = this.seats
      .filter((p) => p.won > 0)
      .map((p) => ({ seat: p.seat, name: p.name, amount: p.won, hand: p.hand.name }));
    for (const r of results) this.log(`${r.name} 以「${r.hand}」贏得 ${r.amount}`);
    this.endHand(results, totalPot);
  }

  endHand(results, pot) {
    for (const p of this.seats) {
      p.bet = 0;
      p.allIn = p.inHand && p.stack === 0;
    }
    this.inHand = false;
    this.toAct = -1;
    this.lastResult = { pot, winners: results };
    const h = this.human;
    this.pendingResult = {
      chips: h.stack,
      played: h.inHand,
      won: h.won > 0,
      pot: h.won > 0 ? pot : 0,
    };
    this.log('本手結束');
  }

  log(msg) {
    this.seq++;
    this.frames.push({ seq: this.seq, msg, state: this.snapshot() });
    if (this.frames.length > MAX_FRAMES) this.frames.splice(0, this.frames.length - MAX_FRAMES);
  }

  framesSince(seq) {
    return this.frames.filter((f) => f.seq > seq);
  }

  snapshot() {
    const h = this.human;
    const state = {
      seq: this.seq,
      handNo: this.handNo,
      street: this.street,
      inHand: this.inHand,
      board: [...this.board],
      pot: this.potTotal(),
      currentBet: this.currentBet,
      dealer: this.dealer,
      sb: this.inHand || this.lastResult ? this.sb : -1,
      bb: this.inHand || this.lastResult ? this.bb : -1,
      toAct: this.inHand ? this.toAct : -1,
      bigBlind: BIG_BLIND,
      result: this.inHand ? null : this.lastResult,
      seats: this.seats.map((p) => ({
        seat: p.seat,
        name: p.name,
        human: p.human,
        style: p.style?.label ?? null,
        stack: p.stack,
        bet: p.bet,
        folded: p.folded,
        allIn: p.allIn,
        inHand: p.inHand,
        lastAction: p.lastAction,
        won: p.won,
        cards: p.human || p.revealed ? [...p.hole] : p.hole.map(() => null),
        handName: p.revealed || (p.human && p.hand) ? p.hand?.name ?? null : null,
      })),
      legal: null,
    };
    if (this.inHand && this.toAct === 0) {
      const { minTo, maxTo } = this.raiseBounds(h);
      state.legal = {
        toCall: Math.min(this.currentBet - h.bet, h.stack),
        canCheck: this.currentBet === h.bet,
        canRaise: maxTo > this.currentBet,
        minTo,
        maxTo,
      };
    }
    // Show the human their current made hand once the flop is out.
    if (h.inHand && !h.revealed && this.board.length >= 3) {
      state.seats[0].handName = evaluate([...h.hole, ...this.board]).name;
    }
    return state;
  }
}

function resetForHand(p) {
  p.hole = [];
  p.folded = false;
  p.allIn = false;
  p.bet = 0;
  p.total = 0;
  p.acted = false;
  p.lastAction = '';
  p.revealed = false;
  p.hand = null;
  p.won = 0;
  p.inHand = false;
}

function canAct(p) {
  return p.inHand && !p.folded && !p.allIn;
}
