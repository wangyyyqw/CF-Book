import { err, jsonWithCookies } from '../../utils/http.js';
import { dbGet } from '../../utils/db.js';
import {
  USERNAME_RE,
  MIN_PASSWORD_LENGTH,
  hashPassword,
  createSession,
  sessionCookie,
  isSecureRequest,
  countUsers,
} from '../../utils/auth.js';

// 仅当系统还没有任何账号时可用，用于创建第一个管理员
export async function onRequestPost(context) {
  const { request, env } = context;
  if ((await countUsers(env)) > 0) return err('系统已完成初始化，请直接登录', 409);

  const serviceToken =
    request.headers.get('x-admin-token') ||
    (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!env.ADMIN_TOKEN || serviceToken !== env.ADMIN_TOKEN) {
    return err('首次初始化需要管理员服务令牌', 401);
  }

  const body = await request.json().catch(() => null);
  if (!body) return err('请求体必须是 JSON');
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const displayName = String(body.displayName || '').trim() || username;

  if (!USERNAME_RE.test(username)) {
    return err('用户名需为 2–32 位字母、数字、下划线、点或短横线');
  }
  if (password.length < MIN_PASSWORD_LENGTH) return err(`密码至少 ${MIN_PASSWORD_LENGTH} 位`);

  const existing = await dbGet(env, 'SELECT id FROM users WHERE username = ?', username);
  if (existing) return err('用户名已存在');

  const now = Math.floor(Date.now() / 1000);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, role, disabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'admin', 0, ?, ?)`
  )
    .bind(id, username, displayName, await hashPassword(password), now, now)
    .run();

  // 老数据里单用户的评分/状态（user_id = 'legacy'）归第一个管理员所有
  await env.DB.prepare('UPDATE book_user_state SET user_id = ? WHERE user_id = ?')
    .bind(id, 'legacy')
    .run();

  const session = await createSession(env, id);
  return jsonWithCookies(
    { ok: true, user: { id, username, display_name: displayName, role: 'admin' } },
    [sessionCookie(session.token, { secure: isSecureRequest(request) })]
  );
}
