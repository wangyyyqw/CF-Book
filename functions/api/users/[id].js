import { json, err } from '../../utils/http.js';
import { dbGet, dbRun, nowSec } from '../../utils/db.js';
import {
  MIN_PASSWORD_LENGTH,
  hashPassword,
  requireAdmin,
  destroyUserSessions,
} from '../../utils/auth.js';

export async function onRequestPatch(context) {
  const denied = requireAdmin(context);
  if (denied) return denied;

  const { request, env, params } = context;
  const me = context.data.user;
  const target = await dbGet(env, 'SELECT * FROM users WHERE id = ?', params.id);
  if (!target) return err('账号不存在', 404);

  const body = await request.json().catch(() => null);
  if (!body) return err('请求体必须是 JSON');

  const displayName =
    body.displayName != null ? String(body.displayName).trim() || target.username : target.display_name;
  const role = body.role != null ? (body.role === 'admin' ? 'admin' : 'member') : target.role;
  const disabled = body.disabled != null ? (body.disabled ? 1 : 0) : target.disabled;
  const password = body.password != null ? String(body.password) : '';

  if (target.id === me.id && (role !== 'admin' || disabled)) {
    return err('不能取消或停用自己的管理员账号');
  }
  if (password && password.length < MIN_PASSWORD_LENGTH) {
    return err(`密码至少 ${MIN_PASSWORD_LENGTH} 位`);
  }
  if (disabled || role !== 'admin') {
    const guard = await lastAdminGuard(env, target);
    if (guard) return guard;
  }

  if (password) {
    await dbRun(
      env,
      'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?',
      await hashPassword(password),
      nowSec(),
      params.id
    );
    await destroyUserSessions(env, params.id);
  }
  await dbRun(
    env,
    'UPDATE users SET display_name = ?, role = ?, disabled = ?, updated_at = ? WHERE id = ?',
    displayName,
    role,
    disabled,
    nowSec(),
    params.id
  );
  if (disabled) await destroyUserSessions(env, params.id);

  return json({ ok: true });
}

export async function onRequestDelete(context) {
  const denied = requireAdmin(context);
  if (denied) return denied;

  const { env, params } = context;
  if (params.id === context.data.user.id) return err('不能删除自己的账号');

  const target = await dbGet(env, 'SELECT * FROM users WHERE id = ?', params.id);
  if (!target) return err('账号不存在', 404);
  const guard = await lastAdminGuard(env, target);
  if (guard) return guard;

  await destroyUserSessions(env, params.id);
  await dbRun(env, 'DELETE FROM book_user_state WHERE user_id = ?', params.id);
  // 清理该账号的个人书架及其成员关系，避免留下不可见的孤儿书架（共享书架归属全体，保留不动）
  await dbRun(
    env,
    `DELETE FROM shelf_books WHERE shelf_id IN
       (SELECT id FROM shelves WHERE scope = 'personal' AND owner = ?)`,
    target.username
  );
  await dbRun(env, "DELETE FROM shelves WHERE scope = 'personal' AND owner = ?", target.username);
  await dbRun(env, 'DELETE FROM users WHERE id = ?', params.id);
  return json({ ok: true });
}

// 保证系统里始终至少留一个可用的管理员
async function lastAdminGuard(env, target) {
  if (target.role !== 'admin' || target.disabled) return null;
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0 AND id != ?"
  )
    .bind(target.id)
    .first();
  return Number(row?.n) > 0 ? null : err('系统需要至少保留一个可用管理员');
}
