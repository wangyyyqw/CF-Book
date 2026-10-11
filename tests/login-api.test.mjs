import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost as login } from '../functions/api/auth/login.js';
import { hashPassword, DUMMY_PASSWORD_HASH, verifyPassword } from '../functions/utils/auth.js';
import { createD1, seedUser } from './helpers/d1.mjs';

async function makeEnv() {
  const DB = createD1();
  seedUser(DB, { id: 'u1', username: 'admin', displayName: '管理员', role: 'admin' });
  DB.exec(`UPDATE users SET password_hash = '${await hashPassword('correct-horse')}' WHERE id = 'u1'`);
  // 被停用的账号：密码正确也不应登录成功
  seedUser(DB, { id: 'u2', username: 'blocked', displayName: '停用', role: 'member' });
  DB.exec(`UPDATE users SET password_hash = '${await hashPassword('right-pass')}', disabled = 1 WHERE id = 'u2'`);
  return { DB };
}

function loginCtx(env, { username, password, ip = '203.0.113.50' } = {}) {
  return {
    env,
    request: new Request('https://example.com/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
      body: JSON.stringify({ username, password }),
    }),
  };
}

test('占位哈希无法被任何密码匹配，用于不存在账号的等价校验', async () => {
  assert.match(DUMMY_PASSWORD_HASH, /^pbkdf2\$100000\$.+\$.+$/);
  assert.equal(await verifyPassword('anything', DUMMY_PASSWORD_HASH), false);
  assert.equal(await verifyPassword('', DUMMY_PASSWORD_HASH), false);
});

test('不存在的用户名返回 401，且与密码错误提示一致，不暴露账号是否存在', async () => {
  const env = await makeEnv();
  const ghost = await login(loginCtx(env, { username: 'ghost', password: 'whatever', ip: '203.0.113.51' }));
  assert.equal(ghost.status, 401);
  const wrongPass = await login(loginCtx(env, { username: 'admin', password: 'bad', ip: '203.0.113.52' }));
  assert.equal(wrongPass.status, 401);
  assert.equal((await ghost.json()).error, (await wrongPass.json()).error);
});

test('被停用账号即使密码正确也返回 401，不签发会话', async () => {
  const env = await makeEnv();
  const res = await login(loginCtx(env, { username: 'blocked', password: 'right-pass', ip: '203.0.113.53' }));
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('set-cookie'), null);
});

test('正确账号密码仍可正常登录并签发会话', async () => {
  const env = await makeEnv();
  const res = await login(loginCtx(env, { username: 'admin', password: 'correct-horse', ip: '203.0.113.54' }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
  assert.match(res.headers.get('set-cookie') || '', /cfbook_session=/);
});
