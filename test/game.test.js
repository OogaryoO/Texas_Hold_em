import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/cards.js';
import { Table, BIG_BLIND } from '../src/game.js';

test('hand ranking order', () => {
  const s = (cards) => evaluate(cards.split(' ')).score;
  assert.equal(evaluate('As Ks Qs Js Ts 2d 3c'.split(' ')).name, '皇家同花順');
  assert.equal(evaluate('5h 4h 3h 2h Ah Kd Kc'.split(' ')).name, '同花順');
  assert.ok(s('9c 9d 9h 9s 2c') > s('Kc Kd Kh Qs Qc'));
  assert.ok(s('Kc Kd Kh Qs Qc') > s('2h 7h 9h Jh Kh'));
  assert.ok(s('2h 7h 9h Jh Kh') > s('Tc Jd Qh Ks Ac'));
  assert.ok(s('5c 4d 3h 2s Ac') < s('6c 5d 4h 3s 2c'), 'wheel is the lowest straight');
  assert.ok(s('Tc Jd Qh Ks Ac') > s('Qc Qd Qh 2s 3c'));
  assert.ok(s('Qc Qd 2h 2s 3c') > s('Ac Ad Kh Qs Jc'));
  assert.ok(s('Ac Ad Kh Qs Jc') > s('Ac Ad Kh Qs Tc'), 'kicker decides');
  assert.equal(s('Ac Kd Qh Js 9c'), s('As Kh Qd Jc 9d'), 'suits do not matter');
});

// Play many hands with a random human; chips must never be created or destroyed.
test('chips are conserved over many random hands', () => {
  const t = new Table({ id: 1, username: 'tester', chips: 5000 });
  const actions = ['fold', 'check', 'call', 'raise', 'raise'];
  for (let hand = 0; hand < 1500; hand++) {
    if (t.human.stack <= 0) t.human.stack = 1000;
    t.startHand();
    const before = t.inHand
      ? t.seats.reduce((sum, p) => sum + p.stack + p.total, 0)
      : t.seats.reduce((sum, p) => sum + p.stack, 0);
    let guard = 0;
    while (t.inHand) {
      assert.ok(guard++ < 50, 'hand should finish');
      const st = t.snapshot();
      const l = st.legal;
      let a = actions[Math.floor(Math.random() * actions.length)];
      if (a === 'check' && !l.canCheck) a = 'call';
      if (a === 'raise' && !l.canRaise) a = 'call';
      const amount = l.minTo + Math.floor(Math.random() * (l.maxTo - l.minTo + 1));
      t.humanAction(a, amount);
    }
    const after = t.seats.reduce((sum, p) => sum + p.stack, 0);
    // Busted bots are replaced at the next deal, so compare from the moment of the deal.
    assert.equal(after, before, `hand ${t.handNo} conserved chips`);
    assert.ok(t.seats.every((p) => p.stack >= 0));
    assert.equal(t.pendingResult.chips, t.human.stack);
    t.pendingResult = null;
    for (const p of t.seats) if (!p.human) assert.ok(p.stack >= 0);
  }
  assert.ok(t.handNo >= 1500);
  assert.ok(BIG_BLIND > 0);
});
