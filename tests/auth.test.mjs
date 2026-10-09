import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPassword,
  verifyPassword,
  timingSafeEqual,
  readCookie,
  sessionCookie,
  clearSessionCookie,
  SESSION_COOKIE,
  USERNAME_RE,
  countUsers,
  userFromRequest,
  createSession,
  destroySession,
} from '../functions/utils/auth.js';

test('密码哈希可直接校验，错误密码被拒绝', async () => {
  const stored = await hashPassword('correct-horse');
  assert.match(stored, /^pbkdf2\$100000\$.+\$.+$/);
  assert.equal(await verifyPassword('correct-horse', stored), true);
  assert.equal(await verifyPassword('wrong-horse', stored), false);
});

test('同一密码两次哈希结果不同（盐随机）', async () => {
  const a = await hashPassword('same-password');
  const b = await hashPassword('same-password');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('same-password', a), true);
  assert.equal(await verifyPassword('same-password', b), true);
});

test('篡改或格式非法的哈希一律拒绝', async () => {
  assert.equal(await verifyPassword('x', ''), false);
  assert.equal(await verifyPassword('x', 'plain-text'), false);
  assert.equal(await verifyPassword('x', 'pbkdf2$100000$notbase64$also'), false);
  assert.equal(await verifyPassword('x', 'pbkdf2$0$AAAA$AAAA'), false);
});

test('timingSafeEqual 同时比较长度与内容', () => {
  const a = new Uint8Array([1, 2, 3]);
  assert.equal(timingSafeEqual(a, new Uint8Array([1, 2, 3])), true);
  assert.equal(timingSafeEqual(a, new Uint8Array([1, 2, 4])), false);
  assert.equal(timingSafeEqual(a, new Uint8Array([1, 2])), false);
});

test('readCookie 能取出目标 Cookie 并忽略其他项', () => {
  const request = new Request('https://example.com/', {
    headers: { Cookie: `other=1; ${SESSION_COOKIE}=abc.def; trailing=2` },
  });
  assert.equal(readCookie(request, SESSION_COOKIE), 'abc.def');
  assert.equal(readCookie(request, 'missing'), '');
});

test('会话 Cookie 带 HttpOnly/SameSite，Secure 由调用方决定', () => {
  const secure = sessionCookie('tok', { secure: true });
  assert.match(secure, /^cfbook_session=tok;/);
  assert.match(secure, /HttpOnly/);
  assert.match(secure, /SameSite=Lax/);
  assert.match(secure, /Secure/);

  const insecure = sessionCookie('tok', { secure: false });
  assert.doesNotMatch(insecure, /Secure/);
  assert.match(clearSessionCookie({ secure: false }), /Max-Age=0/);
});

test('用户名规则允许常见写法并拒绝非法字符', () => {
  assert.ok(USERNAME_RE.test('xiaowang'));
  assert.ok(USERNAME_RE.test('family-01'));
  assert.ok(USERNAME_RE.test('a.b_c'));
  assert.ok(!USERNAME_RE.test('a'));
  assert.ok(!USERNAME_RE.test('带中文'));
  assert.ok(!USERNAME_RE.test('has space'));
  assert.ok(!USERNAME_RE.test('a'.repeat(33)));
});

// —— 会话读写：用最小 D1 替身覆盖「建会话 → Cookie 解析 → 注销失效」链路 ——

function fakeD1() {
  const sessions = new Map();
  const users = new Map();
  return {
    users,
    sessions,
    prepare(sql) {
      const statement = {
        params: [],
        bind(...params) {
          statement.params = params;
          return statement;
        },
        async run() {
          if (sql.startsWith('DELETE FROM sessions WHERE expires_at')) {
            for (const [hash, row] of sessions) {
              if (row.expires_at <= statement.params[0]) sessions.delete(hash);
            }
          } else if (sql.startsWith('INSERT INTO sessions')) {
            const [token_hash, user_id, created_at, expires_at] = statement.params;
            sessions.set(token_hash, { user_id, created_at, expires_at });
          } else if (sql.startsWith('DELETE FROM sessions WHERE token_hash')) {
            sessions.delete(statement.params[0]);
          }
          return { meta: { changes: 1 } };
        },
        async first() {
          if (sql.includes('COUNT(*) AS n FROM users')) return { n: users.size };
          if (sql.includes('FROM sessions s JOIN users u')) {
            const session = sessions.get(statement.params[0]);
            if (!session || session.expires_at <= statement.params[1]) return null;
            return users.get(session.user_id) || null;
          }
          return null;
        },
      };
      return statement;
    },
  };
}

test('会话可创建、经 Cookie 解析为用户，注销后失效', async () => {
  const db = fakeD1();
  const env = { DB: db };
  db.users.set('u1', { id: 'u1', username: 'xiaowang', display_name: '小王', role: 'member' });

  const { token } = await createSession(env, 'u1');
  const context = {
    request: new Request('https://example.com/api/books', {
      headers: { Cookie: `${SESSION_COOKIE}=${token}` },
    }),
    env,
  };
  assert.equal((await userFromRequest(context)).username, 'xiaowang');
  assert.equal(await countUsers(env), 1);

  await destroySession(env, token);
  assert.equal(await userFromRequest(context), null);
});

test('服务令牌可在无会话时以管理员身份通过', async () => {
  const env = { DB: fakeD1(), ADMIN_TOKEN: 'service-secret' };
  const withToken = {
    request: new Request('https://example.com/api/books', {
      headers: { 'x-admin-token': 'service-secret' },
    }),
    env,
  };
  assert.equal((await userFromRequest(withToken)).role, 'admin');

  const wrongToken = {
    request: new Request('https://example.com/api/books', {
      headers: { 'x-admin-token': 'wrong' },
    }),
    env,
  };
  assert.equal(await userFromRequest(wrongToken), null);
});
