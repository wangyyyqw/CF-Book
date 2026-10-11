import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../functions/_middleware.js';

// 无会话、无服务令牌：userFromRequest 会解析为未登录
function env() {
  return {
    DB: {
      prepare() {
        return {
          bind() { return this; },
          async first() { return null; },
          async all() { return { results: [] }; },
          async run() { return { meta: { changes: 0 } }; },
        };
      },
    },
  };
}

function ctx(path, { method = 'GET' } = {}) {
  let nextCalled = false;
  const context = {
    request: new Request(`https://example.com${path}`, { method }),
    env: env(),
    data: {},
    next: async () => {
      nextCalled = true;
      return new Response('ok', { status: 200 });
    },
  };
  return { context, wasNextCalled: () => nextCalled };
}

test('带点号的受保护接口路径仍需鉴权，不被当作静态资源放行', async () => {
  // 修复前：路径含“.”会被后缀启发式判成静态资源而跳过鉴权
  const { context, wasNextCalled } = ctx('/api/books/some.book.id');
  const res = await onRequest(context);
  assert.equal(res.status, 401);
  assert.equal(wasNextCalled(), false, '未鉴权时不应进入业务处理');
});

test('未登录访问受保护页面重定向到 /login', async () => {
  const { context } = ctx('/library');
  const res = await onRequest(context);
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location') || '', /\/login$/);
});

test('静态资源与封面接口无需登录即可访问', async () => {
  for (const path of ['/style.css', '/app.js', '/api/covers/b1.jpg']) {
    const { context, wasNextCalled } = ctx(path);
    const res = await onRequest(context);
    assert.equal(res.status, 200, path);
    assert.equal(wasNextCalled(), true, path);
  }
});

test('公共接口（登录态查询）无需鉴权直接放行', async () => {
  const { context, wasNextCalled } = ctx('/api/auth/me');
  const res = await onRequest(context);
  assert.equal(res.status, 200);
  assert.equal(wasNextCalled(), true);
});

test('OPTIONS 预检直接返回 204 且带 CORS 头', async () => {
  const { context, wasNextCalled } = ctx('/api/books', { method: 'OPTIONS' });
  const res = await onRequest(context);
  assert.equal(res.status, 204);
  assert.equal(wasNextCalled(), false);
  assert.equal(res.headers.get('access-control-allow-methods') ? true : false, true);
});
