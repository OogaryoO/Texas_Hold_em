import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Storage backends, picked at startup:
//   DATABASE_URL set → PostgreSQL (durable; needs egress on BellD, see README)
//   otherwise        → SQLite file via the built-in node:sqlite module
//   node:sqlite missing → JSON file (last resort so the app still starts)

export async function openStore() {
  if (process.env.DATABASE_URL) {
    const store = new PgStore(process.env.DATABASE_URL);
    await store.init();
    console.log('[db] using PostgreSQL');
    return store;
  }
  const dir = resolveDataDir();
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const file = path.join(dir, 'poker.db');
    const store = new SqliteStore(new DatabaseSync(file));
    await store.init();
    console.log(`[db] using SQLite at ${file}`);
    return store;
  } catch (err) {
    const file = path.join(dir, 'poker.json');
    console.warn(`[db] SQLite unavailable (${err.message}); using JSON file at ${file}`);
    const store = new JsonStore(file);
    await store.init();
    return store;
  }
}

function resolveDataDir() {
  const candidates = [process.env.DATA_DIR, path.join(process.cwd(), 'data'), path.join(os.tmpdir(), 'poker-data')];
  for (const dir of candidates) {
    if (!dir) continue;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, '.write-test');
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      return dir;
    } catch {
      // try the next location
    }
  }
  throw new Error('no writable data directory');
}

function toUser(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    username: row.username,
    passwordHash: row.password_hash,
    chips: Number(row.chips),
    handsPlayed: Number(row.hands_played),
    handsWon: Number(row.hands_won),
    biggestPot: Number(row.biggest_pot),
    refills: Number(row.refills),
  };
}

class SqliteStore {
  constructor(db) {
    this.db = db;
  }

  async init() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        username_key TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        chips INTEGER NOT NULL,
        hands_played INTEGER NOT NULL DEFAULT 0,
        hands_won INTEGER NOT NULL DEFAULT 0,
        biggest_pot INTEGER NOT NULL DEFAULT 0,
        refills INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  async getMeta(key) {
    return this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
  }

  async setMeta(key, value) {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  async createUser(username, passwordHash, chips) {
    try {
      const r = this.db.prepare('INSERT INTO users (username, username_key, password_hash, chips) VALUES (?, ?, ?, ?)')
        .run(username, username.toLowerCase(), passwordHash, chips);
      return this.getUser(Number(r.lastInsertRowid));
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) return null;
      throw err;
    }
  }

  async findUserByName(username) {
    return toUser(this.db.prepare('SELECT * FROM users WHERE username_key = ?').get(username.toLowerCase()));
  }

  async getUser(id) {
    return toUser(this.db.prepare('SELECT * FROM users WHERE id = ?').get(id));
  }

  async recordHand(id, { chips, played, won, pot }) {
    this.db.prepare(`UPDATE users SET chips = ?, hands_played = hands_played + ?, hands_won = hands_won + ?,
      biggest_pot = MAX(biggest_pot, ?) WHERE id = ?`).run(chips, played ? 1 : 0, won ? 1 : 0, pot, id);
  }

  async setChips(id, chips, refill = false) {
    this.db.prepare('UPDATE users SET chips = ?, refills = refills + ? WHERE id = ?').run(chips, refill ? 1 : 0, id);
  }

  async leaderboard(limit) {
    return this.db.prepare('SELECT * FROM users ORDER BY chips DESC, id ASC LIMIT ?').all(limit).map(toUser);
  }
}

class PgStore {
  constructor(url) {
    this.url = url;
  }

  async init() {
    const { default: pg } = await import('pg');
    const ssl = process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false };
    this.pool = new pg.Pool({ connectionString: this.url, ssl, max: 5 });
    // The platform proxy can drop idle connections; the pool reconnects on next query.
    this.pool.on('error', (err) => console.warn('[db] idle client error:', err.message));
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL,
        username_key TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        chips INTEGER NOT NULL,
        hands_played INTEGER NOT NULL DEFAULT 0,
        hands_won INTEGER NOT NULL DEFAULT 0,
        biggest_pot INTEGER NOT NULL DEFAULT 0,
        refills INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  async getMeta(key) {
    const r = await this.pool.query('SELECT value FROM meta WHERE key = $1', [key]);
    return r.rows[0]?.value ?? null;
  }

  async setMeta(key, value) {
    await this.pool.query(
      'INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
      [key, value],
    );
  }

  async createUser(username, passwordHash, chips) {
    const r = await this.pool.query(
      `INSERT INTO users (username, username_key, password_hash, chips) VALUES ($1, $2, $3, $4)
       ON CONFLICT (username_key) DO NOTHING RETURNING *`,
      [username, username.toLowerCase(), passwordHash, chips],
    );
    return toUser(r.rows[0]);
  }

  async findUserByName(username) {
    const r = await this.pool.query('SELECT * FROM users WHERE username_key = $1', [username.toLowerCase()]);
    return toUser(r.rows[0]);
  }

  async getUser(id) {
    const r = await this.pool.query('SELECT * FROM users WHERE id = $1', [id]);
    return toUser(r.rows[0]);
  }

  async recordHand(id, { chips, played, won, pot }) {
    await this.pool.query(
      `UPDATE users SET chips = $1, hands_played = hands_played + $2, hands_won = hands_won + $3,
       biggest_pot = GREATEST(biggest_pot, $4) WHERE id = $5`,
      [chips, played ? 1 : 0, won ? 1 : 0, pot, id],
    );
  }

  async setChips(id, chips, refill = false) {
    await this.pool.query('UPDATE users SET chips = $1, refills = refills + $2 WHERE id = $3', [chips, refill ? 1 : 0, id]);
  }

  async leaderboard(limit) {
    const r = await this.pool.query('SELECT * FROM users ORDER BY chips DESC, id ASC LIMIT $1', [limit]);
    return r.rows.map(toUser);
  }
}

class JsonStore {
  constructor(file) {
    this.file = file;
  }

  async init() {
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.data = { nextId: 1, users: [], meta: {} };
    }
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }

  row(id) {
    return this.data.users.find((u) => u.id === id);
  }

  async getMeta(key) {
    return this.data.meta[key] ?? null;
  }

  async setMeta(key, value) {
    this.data.meta[key] = value;
    this.save();
  }

  async createUser(username, passwordHash, chips) {
    const key = username.toLowerCase();
    if (this.data.users.some((u) => u.username_key === key)) return null;
    const row = {
      id: this.data.nextId++, username, username_key: key, password_hash: passwordHash, chips,
      hands_played: 0, hands_won: 0, biggest_pot: 0, refills: 0,
    };
    this.data.users.push(row);
    this.save();
    return toUser(row);
  }

  async findUserByName(username) {
    return toUser(this.data.users.find((u) => u.username_key === username.toLowerCase()));
  }

  async getUser(id) {
    return toUser(this.row(id));
  }

  async recordHand(id, { chips, played, won, pot }) {
    const u = this.row(id);
    if (!u) return;
    u.chips = chips;
    u.hands_played += played ? 1 : 0;
    u.hands_won += won ? 1 : 0;
    u.biggest_pot = Math.max(u.biggest_pot, pot);
    this.save();
  }

  async setChips(id, chips, refill = false) {
    const u = this.row(id);
    if (!u) return;
    u.chips = chips;
    u.refills += refill ? 1 : 0;
    this.save();
  }

  async leaderboard(limit) {
    return [...this.data.users].sort((a, b) => b.chips - a.chips || a.id - b.id).slice(0, limit).map(toUser);
  }
}
