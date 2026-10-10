import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('同一页面的多个模块共享一次登录态请求', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ ok: true, user: { username: 'admin' } }));
  };
  const { loadMe } = await import(`../public/api.js?cache-test=${Date.now()}`);
  const [first, second] = await Promise.all([loadMe(), loadMe()]);
  assert.deepEqual(first, second);
  assert.equal(calls, 1);
});
