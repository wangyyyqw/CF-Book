import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet } from '../functions/api/auth/me.js';
import { createSession, SESSION_COOKIE } from '../functions/utils/auth.js';
import { createD1, seedUser } from './helpers/d1.mjs';

function meContext(env, token) {
  return {
    env,
    request: new Request('https://example.com/api/auth/me', {
      headers: token ? { Cookie: `${SESSION_COOKIE}=${token}` } : {},
    }),
    data: {},
  };
}

test('没有账号时提示需要初始化', async () => {
  const env = { DB: createD1() };
  const data = await (await onRequestGet(meContext(env))).json();
  assert.equal(data.needsSetup, true);
  assert.equal(data.user, null);
  assert.equal(data.multiUser, false);
});

test('单账号登录时 multiUser 为 false 且返回账号数', async () => {
  const env = { DB: createD1() };
  seedUser(env.DB, { id: 'u1', username: 'admin', role: 'admin' });
  const { token } = await createSession(env, 'u1');

  const data = await (await onRequestGet(meContext(env, token))).json();
  assert.equal(data.needsSetup, false);
  assert.equal(data.user.username, 'admin');
  assert.equal(data.multiUser, false);
  assert.equal(data.userCount, 1);
});

test('出现第二个账号后 multiUser 变为 true', async () => {
  const env = { DB: createD1() };
  seedUser(env.DB, { id: 'u1', username: 'admin', role: 'admin' });
  seedUser(env.DB, { id: 'u2', username: 'member', role: 'member' });
  const { token } = await createSession(env, 'u1');

  const data = await (await onRequestGet(meContext(env, token))).json();
  assert.equal(data.multiUser, true);
  assert.equal(data.userCount, 2);
});

test('未登录访问者不会拿到精确账号数，只知道是否多人', async () => {
  const env = { DB: createD1() };
  seedUser(env.DB, { id: 'u1', username: 'admin', role: 'admin' });
  seedUser(env.DB, { id: 'u2', username: 'member', role: 'member' });

  const data = await (await onRequestGet(meContext(env))).json();
  assert.equal(data.user, null);
  assert.equal(data.multiUser, true);
  assert.equal(data.userCount, undefined, '未登录不返回精确账号数');
});
