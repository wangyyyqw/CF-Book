import { json, err } from '../utils/http.js';
import { dbAll, dbGet, dbRun, nowSec } from '../utils/db.js';
import { USERNAME_RE, MIN_PASSWORD_LENGTH, hashPassword, requireAdmin } from '../utils/auth.js';

export async function onRequestGet(context) {
  const denied = requireAdmin(context);
  if (denied) return denied;

  const users = await dbAll(
    context.env,
    `SELECT u.id, u.username, u.display_name, u.role, u.disabled, u.created_at,
       (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS active_sessions,
       (SELECT COUNT(*) FROM books b WHERE b.created_by = u.username) AS book_count
     FROM users u ORDER BY u.created_at`,
    nowSec()
  );
  return json({ ok: true, users });
}

export async function onRequestPost(context) {
  const denied = requireAdmin(context);
  if (denied) return denied;

  const { request, env } = context;
  const body = await request.json().catch(() => null);
  if (!body) return err('请求体必须是 JSON');

  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const displayName = String(body.displayName || '').trim() || username;
  const role = body.role === 'admin' ? 'admin' : 'member';

  if (!USERNAME_RE.test(username)) {
    return err('用户名需为 2–32 位字母、数字、下划线、点或短横线');
  }
  if (password.length < MIN_PASSWORD_LENGTH) return err(`密码至少 ${MIN_PASSWORD_LENGTH} 位`);

  const existing = await dbGet(env, 'SELECT id FROM users WHERE username = ?', username);
  if (existing) return err('用户名已存在');

  const now = nowSec();
  const id = crypto.randomUUID();
  await dbRun(
    env,
    `INSERT INTO users (id, username, display_name, password_hash, role, disabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    id,
    username,
    displayName,
    await hashPassword(password),
    role,
    now,
    now
  );
  return json({ ok: true, user: { id, username, display_name: displayName, role } });
}
