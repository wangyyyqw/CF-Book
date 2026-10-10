import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost } from '../functions/api/upload/complete.js';
import { createD1 } from './helpers/d1.mjs';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeEnv() {
  const DB = createD1();
  DB.exec(`
    INSERT INTO users (id, username, display_name, password_hash, role, disabled, created_at, updated_at)
    VALUES ('u1', 'admin', '管理员', 'x', 'admin', 0, 0, 0);
    INSERT INTO uploads (upload_id, filename, mime, total_size, chunk_size, total_chunks, sha256, status, owner, created_at, updated_at)
    VALUES ('up1', 'book.epub', 'application/epub+zip', 25, 10, 3, '', 'active', 'admin', 1, 1);
    INSERT INTO chunks (upload_id, idx, size, status, updated_at) VALUES
      ('up1', 0, 10, 'uploaded', 1), ('up1', 1, 10, 'uploaded', 1), ('up1', 2, 5, 'uploaded', 1);
  `);
  return { DB };
}

test('上传完成后在后台调用 AI 清洗书名，不阻塞上传响应', async () => {
  const env = makeEnv();
  env.AI = {
    async run() {
      return { response: '挽救计划', usage: { prompt_tokens: 20, completion_tokens: 6 } };
    },
  };
  // 分类后台任务会查询公开书目，这里用空响应避免真实网络请求。
  globalThis.fetch = async () => new Response('{}', { status: 200 });

  const background = [];
  const request = new Request('https://example.test/api/upload/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      uploadId: 'up1',
      sha256: '',
      meta: { title: '挽救计划(《火星救援》作者安迪·威尔全新力作)', author: '' },
    }),
  });
  const response = await onRequestPost({
    env,
    request,
    data: { user: { username: 'admin', role: 'admin' } },
    waitUntil: (promise) => background.push(promise),
  });
  const data = await response.json();
  assert.equal(data.ok, true);
  assert.equal(data.bookCreated, true);
  assert.ok(background.length >= 1, '应在后台排队书名清洗任务');

  await Promise.all(background);
  const book = await env.DB.prepare('SELECT title FROM books WHERE upload_id = ?').bind('up1').first();
  assert.equal(book.title, '挽救计划', '后台清洗应更新 D1 书名');
  const chunks = await env.DB.prepare('SELECT COUNT(*) AS count FROM chunks WHERE upload_id = ?').bind('up1').first();
  assert.equal(chunks.count, 3, '不应改动 Telegram 分块索引');
});

test('同名文件已完成入库时不重复触发后台清洗', async () => {
  const env = makeEnv();
  env.AI = { async run() { return { response: 'x', usage: {} }; } };
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  env.DB.exec(`INSERT INTO books (id, upload_id, title, author, description, cover, format, isbn, publisher, language,
    file_name, file_size, sha256, created_by, created_at, updated_at)
    VALUES ('b1', 'up1', '已有书名', '', '', '', 'epub', '', '', '', 'book.epub', 25, '', 'admin', 1, 1);`);

  const background = [];
  const request = new Request('https://example.test/api/upload/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId: 'up1', sha256: '', meta: { title: '已有书名', author: '' } }),
  });
  const response = await onRequestPost({
    env,
    request,
    data: { user: { username: 'admin', role: 'admin' } },
    waitUntil: (promise) => background.push(promise),
  });
  const data = await response.json();
  assert.equal(data.ok, true);
  assert.equal(background.length, 0, '已存在的书籍不应重复清洗');
});
