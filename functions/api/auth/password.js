import { err, jsonWithCookies } from '../../utils/http.js';
import { dbGet } from '../../utils/db.js';
import {
  MIN_PASSWORD_LENGTH,
  hashPassword,
  verifyPassword,
  createSession,
  destroyUserSessions,
  sessionCookie,
  isSecureRequest,
} from '../../utils/auth.js';

// 修改自己的密码；改完吊销全部旧会话并重新签发
export async function onRequestPost(context) {
  const { request, env } = context;
  const user = context.data?.user;
  if (user?.id === 'service') return err('服务令牌账号不能修改密码');

  const body = await request.json().catch(() => null);
  if (!body) return err('请求体必须是 JSON');
  const currentPassword = String(body.currentPassword || '');
  const newPassword = String(body.newPassword || '');
  if (newPassword.length < MIN_PASSWORD_LENGTH) return err(`新密码至少 ${MIN_PASSWORD_LENGTH} 位`);

  const row = await dbGet(env, 'SELECT * FROM users WHERE id = ?', user.id);
  if (!row) return err('账号不存在', 404);
  if (!(await verifyPassword(currentPassword, row.password_hash))) {
    return err('当前密码不正确', 403);
  }

  await env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .bind(await hashPassword(newPassword), Math.floor(Date.now() / 1000), user.id)
    .run();
  await destroyUserSessions(env, user.id);

  const session = await createSession(env, user.id);
  return jsonWithCookies({ ok: true }, [
    sessionCookie(session.token, { secure: isSecureRequest(request) }),
  ]);
}
