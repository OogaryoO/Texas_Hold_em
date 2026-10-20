import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from './src/db.js';
import { hashPassword, verifyPassword, makeToken, readToken, validateCredentials } from './src/auth.js';
import { Table, GameError, BIG_BLIND } from './src/game.js';

const STARTING_CHIPS = 5000;
const REFILL_CHIPS = 1000;
const TABLE_IDLE_MS = 30 * 60 * 1000;
const COOKIE = 'poker_session';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const staticFiles = new Map();
for (const name of fs.readdirSync(publicDir)) {
  staticFiles.set(`/${name}`, { body: fs.readFileSync(path.join(publicDir, name)), type: TYPES[path.extname(name)] ?? 'application/octet-stream' });
}
staticFiles.set('/', staticFiles.get('/index.html'));

const store = await openStore();
let secret = process.env.SESSION_SECRET || (await store.getMeta('session_secret'));
if (!secret) {
  secret = randomBytes(32).toString('hex');
  await store.setMeta('session_secret', secret);
}

const tables = new Map(); // userId → Table

async function tableFor(user) {
  let t = tables.get(user.id);
  if (!t) {
    t = new Table(user);
    tables.set(user.id, t);
  }
  t.lastActive = Date.now();
  return t;
}

async function persist(t) {
  if (!t.pendingResult) return;
  const r = t.pendingResult;
  t.pendingResult = null;
  await store.recordHand(t.userId, r);
}

// Drop idle tables. A player who walked away mid-hand forfeits what they already bet.
setInterval(async () => {
  const now = Date.now();
  for (const [id, t] of tables) {
    if (now - t.lastActive < TABLE_IDLE_MS) continue;
    tables.delete(id);
    try {
      await persist(t);
      await store.setChips(id, t.human.stack);
    } catch (err) {
      console.error('[table] failed to save idle table', id, err);
    }
  }
}, 60 * 1000).unref();

// Small per-IP limiter for login/register.
const attempts = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) ?? []).filter((t) => now - t < 10 * 60 * 1000);
  list.push(now);
  attempts.set(ip, list);
  return list.length > 30;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function cookies(req) {
  const out = new Map();
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(req, value, maxAge) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

async function readJson(req) {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
    throw new GameError('需要 JSON 請求');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 10_000) throw new GameError('請求太大');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new GameError('JSON 格式錯誤');
  }
}

// The BellD Surface drops Set-Cookie and the Authorization / custom request headers,
// so the client sends the token in the JSON body. Headers and the cookie work locally.
function sessionToken(req, body) {
  if (typeof body.token === 'string') return body.token;
  const auth = req.headers.authorization ?? '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return req.headers['x-session-token'] ?? decodeURIComponent(cookies(req).get(COOKIE) ?? '');
}

async function currentUser(req, body) {
  const id = readToken(sessionToken(req, body), secret);
  return id ? store.getUser(id) : null;
}

function publicUser(u, t) {
  return {
    id: u.id,
    username: u.username,
    chips: t ? t.human.stack : u.chips,
    handsPlayed: u.handsPlayed,
    handsWon: u.handsWon,
    biggestPot: u.biggestPot,
  };
}

function tablePayload(t, since) {
  return { frames: t.framesSince(since), state: t.snapshot() };
}

async function api(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() ?? req.socket.remoteAddress;
  const body = req.method === 'POST' ? await readJson(req) : {};

  if (route === 'POST /api/register' || route === 'POST /api/login') {
    if (rateLimited(ip)) return send(res, 429, { error: '嘗試次數太多，請稍後再試' });
    const { username, password } = body;
    const invalid = validateCredentials(username, password);
    if (invalid) return send(res, 400, { error: invalid });
    let user;
    if (route === 'POST /api/register') {
      user = await store.createUser(username, await hashPassword(password), STARTING_CHIPS);
      if (!user) return send(res, 409, { error: '這個帳號已經有人使用' });
    } else {
      user = await store.findUserByName(username);
      if (!user || !(await verifyPassword(password, user.passwordHash))) {
        return send(res, 401, { error: '帳號或密碼錯誤' });
      }
    }
    const token = makeToken(user.id, secret);
    const cookie = sessionCookie(req, token, 30 * 24 * 3600);
    return send(res, 200, { user: publicUser(user, tables.get(user.id)), token }, { 'set-cookie': cookie });
  }

  if (route === 'POST /api/logout') {
    return send(res, 200, { ok: true }, { 'set-cookie': sessionCookie(req, '', 0) });
  }

  if (route === 'GET /api/leaderboard') {
    const rows = await store.leaderboard(20);
    return send(res, 200, {
      players: rows.map((u) => {
        const live = tables.get(u.id);
        return { username: u.username, chips: live ? live.human.stack : u.chips, handsPlayed: u.handsPlayed, handsWon: u.handsWon, biggestPot: u.biggestPot };
      }).sort((a, b) => b.chips - a.chips),
    });
  }

  const user = await currentUser(req, body);
  if (!user) return send(res, 401, { error: '請先登入' });

  if (route === 'GET /api/me' || route === 'POST /api/me') {
    return send(res, 200, { user: publicUser(user, tables.get(user.id)) });
  }

  const t = await tableFor(user);

  if (route === 'GET /api/table' || route === 'POST /api/table') {
    const since = Number(body.since ?? url.searchParams.get('since')) || 0;
    return send(res, 200, tablePayload(t, since));
  }

  if (route === 'POST /api/table/deal' || route === 'POST /api/table/action') {
    const since = t.seq;
    if (route === 'POST /api/table/deal') t.startHand();
    else t.humanAction(body.action, body.amount);
    await persist(t);
    return send(res, 200, tablePayload(t, since));
  }

  if (route === 'POST /api/refill') {
    if (t.inHand && t.human.inHand && !t.human.folded) throw new GameError('這一手打完才能領取');
    if (t.human.stack >= BIG_BLIND) throw new GameError(`籌碼少於 ${BIG_BLIND} 才能領取救濟金`);
    t.human.stack = REFILL_CHIPS;
    await store.setChips(user.id, REFILL_CHIPS, true);
    const since = t.seq;
    t.log(`${t.human.name} 領取救濟金 ${REFILL_CHIPS}`);
    return send(res, 200, tablePayload(t, since));
  }

  return send(res, 404, { error: 'not found' });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname === '/healthz') return send(res, 200, { ok: true });
    const file = staticFiles.get(url.pathname);
    if (req.method === 'GET' && file) {
      res.writeHead(200, {
        'content-type': file.type,
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'same-origin',
      });
      return res.end(file.body);
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  } catch (err) {
    if (err instanceof GameError) return send(res, 400, { error: err.message });
    console.error(err);
    send(res, 500, { error: '伺服器錯誤' });
  }
});

const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => console.log(`poker listening on :${port}`));
