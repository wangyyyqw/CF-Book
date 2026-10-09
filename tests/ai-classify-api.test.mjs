import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost } from '../functions/api/ai/classify.js';
import { createD1 } from './helpers/d1.mjs';

test('管理员强制分类支持 offset 分批覆盖已完成记录', async () => {
  const DB = createD1();
  DB.exec(`
    INSERT INTO users (id, username, display_name, password_hash, role, disabled, created_at, updated_at)
    VALUES ('u1', 'admin', '管理员', 'x', 'admin', 0, 0, 0);
    INSERT INTO books (id, title, author, file_name, created_by, created_at, updated_at)
    VALUES ('b1', '书一', '作者', '1.epub', 'admin', 1, 1),
           ('b2', '书二', '作者', '2.epub', 'admin', 2, 2),
           ('b3', '书三', '作者', '3.epub', 'admin', 3, 3);
    INSERT INTO ai_classifications (book_id, status, attempts, updated_at)
    VALUES ('b1', 'completed', 1, 1), ('b2', 'completed', 1, 1), ('b3', 'completed', 1, 1);
  `);
  const env = {
    DB,
    AI: { async run() { return { response: JSON.stringify({ title: '清理后的书名', tags: ['历史', '小说', '其他'] }), usage: {} }; } },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  try {
    const request = new Request('https://example.test/api/ai/classify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 2, offset: 2, force: true }),
    });
    const response = await onRequestPost({ request, env, data: { user: { role: 'admin' } } });
    const result = await response.json();
    assert.equal(result.processed, 1);
    assert.equal(result.results[0].bookId, 'b3');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
