const $ = (id) => document.getElementById(id);
const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };
const RANK = { T: '10' };
const POS_WIDE = [[50, 88], [12, 70], [12, 28], [50, 10], [88, 28], [88, 70]];
const POS_NARROW = [[50, 88], [15, 74], [15, 26], [50, 12], [85, 26], [85, 74]];
const narrow = matchMedia('(max-width: 720px)');

let me = null;
let mode = 'login';
let lastSeq = 0;
let current = null;
let busy = false;
const queue = [];

async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- auth ----------
function setMode(m) {
  mode = m;
  $('tab-login').classList.toggle('active', m === 'login');
  $('tab-register').classList.toggle('active', m === 'register');
  $('auth-submit').textContent = m === 'login' ? '登入' : '註冊並入座';
  $('password').autocomplete = m === 'login' ? 'current-password' : 'new-password';
  $('auth-error').textContent = '';
}
$('tab-login').onclick = () => setMode('login');
$('tab-register').onclick = () => setMode('register');

$('auth-form').onsubmit = async (e) => {
  e.preventDefault();
  $('auth-error').textContent = '';
  $('auth-submit').disabled = true;
  try {
    const { user } = await call('POST', `/api/${mode}`, { username: $('username').value.trim(), password: $('password').value });
    $('password').value = '';
    await enter(user);
  } catch (err) {
    $('auth-error').textContent = err.message;
  } finally {
    $('auth-submit').disabled = false;
  }
};

$('btn-logout').onclick = async () => {
  await call('POST', '/api/logout').catch(() => {});
  me = null;
  showAuth();
};

function showAuth() {
  $('auth').hidden = false;
  $('game').hidden = true;
  $('userbar').hidden = true;
  $('username').focus();
}

async function enter(user) {
  me = user;
  $('who').textContent = user.username;
  $('userbar').hidden = false;
  $('auth').hidden = true;
  $('game').hidden = false;
  $('log').innerHTML = '';
  const { frames, state } = await call('GET', '/api/table?since=0');
  for (const f of frames.slice(-40)) addLog(f.msg);
  lastSeq = state.seq;
  current = state;
  render(state);
}

// ---------- leaderboard ----------
$('btn-board').onclick = async () => {
  const { players } = await call('GET', '/api/leaderboard');
  $('lb-body').innerHTML = players.map((p, i) => `
    <tr class="${p.username === me?.username ? 'me' : ''}">
      <td>${i + 1}</td><td>${esc(p.username)}</td><td>${fmt(p.chips)}</td>
      <td>${p.handsPlayed}</td><td>${p.handsWon}</td><td>${fmt(p.biggestPot)}</td>
    </tr>`).join('');
  $('board-dialog').showModal();
};

// ---------- game actions ----------
async function act(url, body) {
  if (busy) return;
  busy = true;
  render(current);
  try {
    const { frames, state } = await call('POST', url, body ?? {});
    queue.push(...frames.filter((f) => f.seq > lastSeq));
    await play();
    current = state;
    lastSeq = state.seq;
  } catch (err) {
    if (err.status === 401) return showAuth();
    $('banner').textContent = err.message;
  } finally {
    busy = false;
    render(current);
  }
}

async function play() {
  while (queue.length) {
    const f = queue.shift();
    addLog(f.msg);
    current = f.state;
    lastSeq = f.seq;
    render(f.state, f.msg);
    const actor = f.state.seats.find((s) => f.msg.startsWith(s.name + ' '));
    let delay = 650;
    if (/^(翻牌|轉牌|河牌)/.test(f.msg)) delay = 900;
    else if (actor?.human) delay = 250;
    else if (/本手結束/.test(f.msg)) delay = 0;
    else if (/贏得/.test(f.msg)) delay = 1200;
    if (queue.length) await sleep(delay);
  }
}

$('btn-deal').onclick = () => act('/api/table/deal');
$('btn-refill').onclick = () => act('/api/refill');
// Action buttons only work while it is our turn and nothing is replaying.
const myTurn = () => !busy && !queue.length && current?.legal;
$('btn-fold').onclick = () => myTurn() && act('/api/table/action', { action: 'fold' });
$('btn-call').onclick = () => myTurn() && act('/api/table/action', { action: current.legal.canCheck ? 'check' : 'call' });
$('btn-raise').onclick = () => myTurn() && act('/api/table/action', { action: 'raise', amount: Number($('raise-input').value) });

const clampRaise = (v) => {
  const l = current?.legal;
  if (!l) return v;
  return Math.max(l.minTo, Math.min(l.maxTo, Math.round(v / 10) * 10 || l.minTo));
};
$('raise-range').oninput = (e) => { $('raise-input').value = e.target.value; updateRaiseLabel(); };
$('raise-input').onchange = (e) => {
  e.target.value = clampRaise(Number(e.target.value));
  $('raise-range').value = e.target.value;
  updateRaiseLabel();
};
document.querySelectorAll('[data-q]').forEach((b) => {
  b.onclick = () => {
    const l = current?.legal;
    if (!l) return;
    const potAfterCall = current.pot + l.toCall;
    const v = { min: l.minTo, half: current.currentBet + potAfterCall / 2, pot: current.currentBet + potAfterCall, all: l.maxTo }[b.dataset.q];
    $('raise-input').value = b.dataset.q === 'all' ? l.maxTo : clampRaise(v);
    $('raise-range').value = $('raise-input').value;
    updateRaiseLabel();
  };
});
function updateRaiseLabel() {
  const l = current?.legal;
  if (!l) return;
  const v = Number($('raise-input').value);
  const word = current.currentBet === 0 ? '下注' : '加注到';
  $('btn-raise').textContent = v >= l.maxTo ? `全下 ${fmt(l.maxTo)}` : `${word} ${fmt(v)}`;
}

// ---------- rendering ----------
function render(s, msg) {
  if (!s) return;
  const me0 = s.seats[0];
  $('bankroll').textContent = fmt(me0.stack);

  const shown = $('board').children.length;
  $('board').innerHTML = s.board.map((c, i) => cardHtml(c, i >= shown)).join('');
  $('pot').textContent = s.pot > 0 ? `底池 ${fmt(s.pot)}` : '';

  let banner = '';
  if (s.result && !s.inHand) {
    banner = s.result.winners.map((w) => `${w.name} 贏得 ${fmt(w.amount)}${w.hand ? `（${w.hand}）` : ''}`).join('、');
  } else if (msg && /^(翻牌|轉牌|河牌)/.test(msg)) {
    banner = msg;
  }
  $('banner').textContent = banner;

  const pos = narrow.matches ? POS_NARROW : POS_WIDE;
  const winners = new Set((s.result?.winners ?? []).map((w) => w.seat));
  $('seats').innerHTML = s.seats.map((p, i) => {
    const [x, y] = pos[i];
    const bx = x + (50 - x) * 0.42;
    const by = y + (50 - y) * 0.42;
    const cls = ['seat', p.human ? 'me' : '', p.folded ? 'folded' : '', s.toAct === i ? 'turn' : '', !s.inHand && winners.has(i) ? 'winner' : ''].join(' ');
    const cards = p.cards.map((c) => (c ? cardHtml(c) : '<div class="card back"></div>')).join('');
    const tag = s.sb === i ? '<div class="blind-tag">SB</div>' : s.bb === i ? '<div class="blind-tag">BB</div>' : '';
    const status = p.allIn && s.inHand ? '全下' : p.lastAction;
    return `
      <div class="${cls}" style="left:${x}%;top:${y}%">
        <div class="cards">${p.inHand && (!p.folded || p.human) ? cards : ''}</div>
        <div class="plate">
          ${s.dealer === i ? '<div class="dealer-btn">D</div>' : ''}${tag}
          <div class="name">${esc(p.name)}${p.human ? '（你）' : ''}</div>
          ${p.style ? `<div class="style">${esc(p.style)}</div>` : ''}
          <div class="stack">${fmt(p.stack)}</div>
          <div class="action">${esc(status || '')}</div>
          ${p.handName ? `<div class="hand">${esc(p.handName)}</div>` : ''}
        </div>
      </div>
      ${p.bet > 0 ? `<div class="bet" style="left:${bx}%;top:${by}%">${fmt(p.bet)}</div>` : ''}`;
  }).join('');

  const ourTurn = s.inHand && s.toAct === 0 && s.legal && !busy && !queue.length;
  $('act-controls').hidden = !ourTurn;
  $('idle-controls').hidden = s.inHand || busy;
  $('wait').hidden = !(busy && s.inHand && s.toAct !== 0);
  const broke = me0.stack < s.bigBlind;
  $('btn-refill').hidden = !broke;
  $('btn-deal').hidden = me0.stack <= 0;
  $('btn-deal').textContent = s.handNo === 0 ? '發牌' : '下一手';
  $('btn-deal').disabled = busy;
  $('btn-refill').disabled = busy;

  if (ourTurn) {
    const l = s.legal;
    $('btn-call').textContent = l.canCheck ? '過牌' : l.toCall >= me0.stack ? `全下跟注 ${fmt(l.toCall)}` : `跟注 ${fmt(l.toCall)}`;
    $('btn-raise').hidden = !l.canRaise;
    $('raise-box').hidden = !l.canRaise;
    if (l.canRaise) {
      const r = $('raise-range');
      r.min = l.minTo;
      r.max = l.maxTo;
      const prev = Number($('raise-input').value);
      const v = prev >= l.minTo && prev <= l.maxTo && s.seq === lastSeq ? prev : l.minTo;
      r.value = v;
      $('raise-input').min = l.minTo;
      $('raise-input').max = l.maxTo;
      $('raise-input').value = v;
      updateRaiseLabel();
    }
  }
}

function cardHtml(c, fresh) {
  const r = RANK[c[0]] ?? c[0];
  const red = c[1] === 'h' || c[1] === 'd';
  return `<div class="card ${red ? 'red' : ''} ${fresh ? 'deal' : ''}">${r}<span>${SUIT[c[1]]}</span></div>`;
}

function addLog(msg) {
  const li = document.createElement('li');
  li.textContent = msg;
  $('log').appendChild(li);
  $('log').scrollTop = $('log').scrollHeight;
}

function fmt(n) {
  return Number(n).toLocaleString('zh-TW');
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

narrow.addEventListener('change', () => render(current));

// ---------- boot ----------
call('GET', '/api/me')
  .then(({ user }) => enter(user))
  .catch(() => showAuth());
