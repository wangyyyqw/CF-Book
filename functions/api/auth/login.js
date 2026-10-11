import { err, jsonWithCookies } from '../../utils/http.js';
import { dbGet } from '../../utils/db.js';
import { verifyPassword, createSession, sessionCookie, isSecureRequest, DUMMY_PASSWORD_HASH } from '../../utils/auth.js';
import {
  loginAttemptKeys,
  loginLockRemaining,
  recordLoginFailure,
  clearLoginFailures,
} from '../../utils/login-guard.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const body = await request.json().catch(() => null);
  if (!body) return err('请求体必须是 JSON');

  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!username || !password) return err('请输入用户名和密码');

  // 先按 IP 与用户名两个维度查锁定状态，命中则直接拒绝、不走密码校验
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const keys = loginAttemptKeys(username, ip);
  const locked = await loginLockRemaining(env, keys);
  if (locked > 0) {
    const minutes = Math.ceil(locked / 60);
    return err(`登录尝试过于频繁，请 ${minutes} 分钟后再试`, 429);
  }

  const user = await dbGet(env, 'SELECT * FROM users WHERE username = ?', username);
  // 用户不存在/被停用时也跑一次等价 PBKDF2，保持响应时延一致，避免用计时差异枚举用户名
  const passwordHash = user && !user.disabled ? user.password_hash : DUMMY_PASSWORD_HASH;
  const passwordOk = await verifyPassword(password, passwordHash);
  // 用户不存在、被停用或密码错误都返回同样的提示，避免暴露账号是否存在
  if (!user || user.disabled || !passwordOk) {
    await recordLoginFailure(env, keys);
    return err('用户名或密码不正确', 401);
  }

  // 登录成功后清零两个维度的失败记录
  await clearLoginFailures(env, keys);
  const session = await createSession(env, user.id);
  return jsonWithCookies(
    {
      ok: true,
      user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role },
    },
    [sessionCookie(session.token, { secure: isSecureRequest(request) })]
  );
}
