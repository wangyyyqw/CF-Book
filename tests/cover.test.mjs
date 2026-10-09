import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost } from '../functions/api/books/[id]/cover.js';

function env() {
  const updates = [];
  const stored = [];
  const DB = {
    prepare(sql) {
      const stmt = {
        params: [],
        bind(...params) {
          stmt.params = params;
          return stmt;
        },
        async first() {
          return sql.includes('FROM books WHERE id')
            ? { id: 'b1', created_by: 'admin', cover: '' }
            : null;
        },
        async run() {
          updates.push({ sql, params: stmt.params });
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  return {
    env: {
      DB,
      COVERS: { async put(key, bytes, options) { stored.push({ key, bytes, options }); } },
    },
    stored,
    updates,
  };
}

function context(env, body) {
  return {
    env,
    params: { id: 'b1' },
    data: { user: { username: 'admin', role: 'admin' } },
    request: new Request('https://example.com/api/books/b1/cover', { method: 'POST', body }),
  };
}

test('外链 JPEG 封面会被抓取并保存到 R2', async () => {
  const state = env();
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
      status: 200,
      headers: { 'content-type': 'image/jpeg', 'content-length': '4' },
    });
  try {
    const form = new FormData();
    form.append('sourceUrl', 'https://example.com/cover.jpg');
    const response = await onRequestPost(context(state.env, form));
    assert.equal(response.status, 200);
    assert.equal(state.stored[0].key, 'covers/b1.jpg');
    assert.equal(state.stored[0].options.httpMetadata.contentType, 'image/jpeg');
    assert.equal(state.updates[0].params[0], '/api/covers/b1.jpg');
  } finally {
    globalThis.fetch = original;
  }
});

test('外链封面拒绝本地地址，避免把接口变成 SSRF', async () => {
  const state = env();
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response('unexpected', { status: 200 });
  };
  try {
    const form = new FormData();
    form.append('sourceUrl', 'http://127.0.0.1/internal.jpg');
    const response = await onRequestPost(context(state.env, form));
    assert.equal(response.status, 502);
    assert.equal(called, false);
    assert.equal(state.stored.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});
