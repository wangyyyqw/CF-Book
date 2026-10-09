import { err, jsonWithCookies } from '../../utils/http.js';
import { dbGet } from '../../utils/db.js';
import { verifyPassword, createSession, sessionCookie, isSecureRequest } from '../../utils/auth.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const body = await request.json().catch(() => null);
  if (!body) return err('请求体必须是 JSON');

  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!username || !password) return err('请输入用户名和密码');

  const user = await dbGet(env, 'SELECT * FROM users WHERE username = ?', username);
  // 用户不存在与密码错误返回同样的提示，避免暴露账号是否存在
  if (!user || user.disabled) return err('用户名或密码不正确', 401);
  if (!(await verifyPassword(password, user.password_hash))) {
    return err('用户名或密码不正确', 401);
  }

  const session = await createSession(env, user.id);
  return jsonWithCookies(
    {
      ok: true,
      user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role },
    },
    [sessionCookie(session.token, { secure: isSecureRequest(request) })]
  );
}
