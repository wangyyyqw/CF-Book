import { sha256Hex } from './hash.js';
import { err } from './http.js';

const PBKDF2_ITERATIONS = 100000;
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 会话有效期 30 天
export const SESSION_COOKIE = 'cfbook_session';

export const USERNAME_RE = /^[A-Za-z0-9_.-]{2,32}$/;
export const MIN_PASSWORD_LENGTH = 6;

// 定格的无效口令哈希：用户不存在或被停用时，用它跑一次等价的 PBKDF2，
// 让响应时延与真实账号一致，避免用计时差异枚举有效用户名。
export const DUMMY_PASSWORD_HASH =
  `pbkdf2$${PBKDF2_ITERATIONS}$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=`;

const encoder = new TextEncoder();

function bytesToB64(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64ToBytes(text) {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function deriveBits(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    256
  );
  return new Uint8Array(bits);
}

// 存储格式：pbkdf2$迭代次数$盐(base64)$摘要(base64)
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const digest = await deriveBits(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToB64(salt)}$${bytesToB64(digest)}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations <= 0) return false;
  let salt;
  let expected;
  try {
    salt = b64ToBytes(parts[2]);
    expected = b64ToBytes(parts[3]);
  } catch {
    return false;
  }
  return timingSafeEqual(await deriveBits(password, salt, iterations), expected);
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

export async function createSession(env, userId) {
  const token = randomToken();
  const tokenHash = await sha256Hex(encoder.encode(token));
  const now = nowSec();
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now).run();
  await env.DB.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  )
    .bind(tokenHash, userId, now, now + SESSION_TTL_SECONDS)
    .run();
  return { token, expiresAt: now + SESSION_TTL_SECONDS };
}

export async function destroySession(env, token) {
  if (!token) return;
  const tokenHash = await sha256Hex(encoder.encode(token));
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
}

export async function destroyUserSessions(env, userId) {
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
}

export function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return '';
}

export function sessionCookie(token, { secure = true, maxAge = SESSION_TTL_SECONDS } = {}) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie({ secure = true } = {}) {
  return sessionCookie('', { secure, maxAge: 0 });
}

// 服务令牌（x-admin-token / Bearer）用于脚本与应急，权限等同管理员
function serviceUser(env, request) {
  const expected = env.ADMIN_TOKEN;
  if (!expected) return null;
  const provided =
    request.headers.get('x-admin-token') ||
    (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!provided) return null;
  if (!timingSafeEqual(encoder.encode(provided), encoder.encode(expected))) return null;
  return { id: 'service', username: 'service', display_name: '管理员令牌', role: 'admin' };
}

export async function userFromRequest(context) {
  const { request, env } = context;
  const token = readCookie(request, SESSION_COOKIE);
  if (token) {
    const tokenHash = await sha256Hex(encoder.encode(token));
    const row = await env.DB.prepare(
      `SELECT u.id, u.username, u.display_name, u.role
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0`
    )
      .bind(tokenHash, nowSec())
      .first();
    if (row) {
      return { id: row.id, username: row.username, display_name: row.display_name, role: row.role };
    }
  }
  return serviceUser(env, request);
}

export function requireAdmin(context) {
  const user = context.data?.user;
  if (!user) return err('请先登录', 401);
  if (user.role !== 'admin') return err('需要管理员权限', 403);
  return null;
}

export function isSecureRequest(request) {
  return new URL(request.url).protocol === 'https:';
}

export async function countUsers(env) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
  return Number(row?.n) || 0;
}
