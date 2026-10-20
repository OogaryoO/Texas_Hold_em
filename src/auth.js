import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scryptAsync(password, salt, 64);
  return `scrypt$${salt}$${hash.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, salt, hex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !hex) return false;
  const expected = Buffer.from(hex, 'hex');
  const actual = await scryptAsync(password, salt, expected.length);
  return timingSafeEqual(expected, actual);
}

function sign(payload, secret) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function makeToken(userId, secret) {
  const payload = `${userId}.${Date.now() + TOKEN_TTL_MS}`;
  return `${payload}.${sign(payload, secret)}`;
}

export function readToken(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const payload = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(sign(payload, secret));
  const actual = Buffer.from(parts[2]);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  if (Number(parts[1]) < Date.now()) return null;
  const id = Number(parts[0]);
  return Number.isInteger(id) ? id : null;
}

export function validateCredentials(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string') return '請輸入帳號與密碼';
  if (!/^[A-Za-z0-9_一-鿿]{3,16}$/.test(username)) return '帳號需為 3–16 個字（中英文、數字或底線）';
  if (password.length < 6 || password.length > 72) return '密碼長度需為 6–72 個字元';
  return null;
}
