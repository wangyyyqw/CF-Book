import { json } from '../../utils/http.js';
import { userFromRequest, countUsers } from '../../utils/auth.js';

export async function onRequestGet(context) {
  const { env } = context;
  const userCount = await countUsers(env);
  const needsSetup = userCount === 0;
  const user = needsSetup ? null : await userFromRequest(context);
  // multiUser 控制前端是否展示“多人使用”相关 UI；精确账号数仅对已登录用户返回，避免对外泄露
  return json({ ok: true, needsSetup, user, multiUser: userCount > 1, userCount: user ? userCount : undefined });
}
