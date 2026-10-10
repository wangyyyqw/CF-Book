import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost as login } from '../functions/api/auth/login.js';
import { hashPassword } from '../functions/utils/auth.js';
import {
  loginAttemptKeys,
  loginLockRemaining,
  recordLoginFailure,
  clearLoginFailures,
  MAX_ATTEMPTS,
  WINDOW_SECONDS,
  LOCK_SECONDS,
} from '../functions/utils/login-guard.js';
import { createD1, seedUser } from './helpers/d1.mjs';

async function makeEnv() {
  const DB = createD1();
  seedUser(DB, { id: 'u1', username: 'admin', displayName: '管理员', role: 'admin' });
  // 用真实哈希覆盖占位密码，便于验证成功登录路径
  DB.exec(`UPDATE users SET password_hash = '${await hashPassword('correct-horse')}' WHERE id = 'u1'`);
  return { DB };
}

function loginCtx(env, { username, password, ip = '203.0.113.9' } = {}) {
  return {
    env,
    request: new Request('https://example.com/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
      body: JSON.stringify({ username, password }),
    }),
  };
}

test('loginAttemptKeys 同时生成 IP 与用户名维度并忽略空值', () => {
  assert.deepEqual(loginAttemptKeys('Admin', '1.2.3.4'), ['ip:1.2.3.4', 'user:admin']);
  assert.deepEqual(loginAttemptKeys('', '1.2.3.4'), ['ip:1.2.3.4']);
  assert.deepEqual(loginAttemptKeys('admin', ''), ['user:admin']);
  assert.deepEqual(loginAttemptKeys('', ''), []);
});

test('达到阈值后锁定，窗口过期后计数重置', async () => {
  const env = await makeEnv();
  const keys = ['ip:198.51.100.7'];
  const start = 1_000_000;
  for (let i = 0; i < MAX_ATTEMPTS - 1; i += 1) {
    await recordLoginFailure(env, keys, start + i);
    assert.equal(await loginLockRemaining(env, keys, start + i), 0, '未达阈值不应锁定');
  }
  await recordLoginFailure(env, keys, start + MAX_ATTEMPTS - 1);
  const remaining = await loginLockRemaining(env, keys, start + MAX_ATTEMPTS - 1);
  assert.equal(remaining, LOCK_SECONDS, '第 5 次失败应触发锁定');

  // 锁定自然过期后再次失败，计数从头开始，不会立即二次锁定
  const later = start + LOCK_SECONDS + WINDOW_SECONDS + 1;
  await recordLoginFailure(env, keys, later);
  assert.equal(await loginLockRemaining(env, keys, later), 0, '窗口过期后计数应重置');
});

test('成功登录清零失败记录', async () => {
  const env = await makeEnv();
  const keys = loginAttemptKeys('admin', '203.0.113.9');
  await recordLoginFailure(env, keys);
  await recordLoginFailure(env, keys);
  await clearLoginFailures(env, keys);
  const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_attempts').first();
  assert.equal(rows.n, 0, '清零后不应残留限流记录');
});

test('连续密码错误触发 429，正确密码在未锁定时仍可登录', async () => {
  const env = await makeEnv();
  for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
    const res = await login(loginCtx(env, { username: 'admin', password: 'wrong' }));
    assert.equal(res.status, 401, '错误密码返回 401');
  }
  // 第 6 次：即使密码正确，也因已锁定被拒绝
  const locked = await login(loginCtx(env, { username: 'admin', password: 'correct-horse' }));
  assert.equal(locked.status, 429);
  assert.match((await locked.json()).error, /过于频繁/);
});

test('锁定按维度隔离：换一个 IP 的正确密码不受影响', async () => {
  const env = await makeEnv();
  // 攻击者 IP 连续失败并锁定（用户名维度也会计数，所以换用其它账号验证 IP 隔离）
  for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
    await login(loginCtx(env, { username: 'ghost', password: 'wrong', ip: '198.51.100.1' }));
  }
  const blocked = await login(loginCtx(env, { username: 'ghost', password: 'x', ip: '198.51.100.1' }));
  assert.equal(blocked.status, 429, '同一 IP 的后续请求被锁定');

  const ok = await login(loginCtx(env, { username: 'admin', password: 'correct-horse', ip: '203.0.113.9' }));
  assert.equal(ok.status, 200, '其他 IP 且账号未被攻击时正常登录');
  assert.equal((await ok.json()).ok, true);
});

test('成功登录后清零，之前的失败不累加到下次锁定', async () => {
  const env = await makeEnv();
  await login(loginCtx(env, { username: 'admin', password: 'wrong' }));
  await login(loginCtx(env, { username: 'admin', password: 'wrong' }));
  const ok = await login(loginCtx(env, { username: 'admin', password: 'correct-horse' }));
  assert.equal(ok.status, 200);
  const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_attempts').first();
  assert.equal(rows.n, 0, '成功登录应清空 IP 与用户名维度的失败记录');
});
