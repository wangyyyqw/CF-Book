import { dbGet, dbRun, nowSec } from './db.js';

// 登录失败限流：按 IP 与用户名两个维度分别计数，命中任一维度的锁定即拒绝。
// 窗口内累计失败达到阈值后锁定一段时间；成功登录清零。瞬态安全数据，不纳入备份。
export const MAX_ATTEMPTS = 5; // 窗口内允许的最大失败次数
export const WINDOW_SECONDS = 15 * 60; // 失败计数窗口
export const LOCK_SECONDS = 15 * 60; // 触发阈值后的锁定时长

// 生成限流维度键：IP 维度拦住单机爆破与撞库，用户名维度拦住分布式针对单账号的爆破。
export function loginAttemptKeys(username, ip) {
  const keys = [];
  const cleanIp = String(ip || '').trim();
  const cleanUser = String(username || '').trim().toLowerCase();
  if (cleanIp) keys.push(`ip:${cleanIp}`);
  if (cleanUser) keys.push(`user:${cleanUser}`);
  return keys;
}

// 返回最大剩余锁定秒数，0 表示未锁定。
export async function loginLockRemaining(env, keys, now = nowSec()) {
  let remaining = 0;
  for (const key of keys) {
    const row = await dbGet(env, 'SELECT locked_until FROM login_attempts WHERE key = ?', key);
    if (row && row.locked_until > now) remaining = Math.max(remaining, row.locked_until - now);
  }
  return remaining;
}

// 记录一次失败。只在未锁定时调用（锁定期直接拒绝、不计数）。
// 窗口过期则重置计数，累计达到阈值则落锁。
export async function recordLoginFailure(env, keys, now = nowSec()) {
  for (const key of keys) {
    const row = await dbGet(env, 'SELECT attempts, first_at FROM login_attempts WHERE key = ?', key);
    const inWindow = row && now - row.first_at < WINDOW_SECONDS;
    const attempts = inWindow ? row.attempts + 1 : 1;
    const firstAt = inWindow ? row.first_at : now;
    const lockedUntil = attempts >= MAX_ATTEMPTS ? now + LOCK_SECONDS : 0;
    await dbRun(
      env,
      `INSERT INTO login_attempts (key, attempts, first_at, locked_until, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET attempts = excluded.attempts, first_at = excluded.first_at,
         locked_until = excluded.locked_until, updated_at = excluded.updated_at`,
      key,
      attempts,
      firstAt,
      lockedUntil,
      now
    );
  }
}

// 成功登录后清零相关维度的失败记录。
export async function clearLoginFailures(env, keys) {
  for (const key of keys) {
    await dbRun(env, 'DELETE FROM login_attempts WHERE key = ?', key);
  }
}
