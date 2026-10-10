import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet, onRequestPost } from '../functions/api/ai/title-clean.js';
import { createD1 } from './helpers/d1.mjs';

function makeEnv() {
  const DB = createD1();
  DB.exec(`
    INSERT INTO users (id, username, display_name, password_hash, role, disabled, created_at, updated_at)
    VALUES ('u1', 'admin', '管理员', 'x', 'admin', 0, 0, 0), ('u2', 'member', '成员', 'x', 'member', 0, 0, 0);
    INSERT INTO books (id, upload_id, title, author, description, cover, format, isbn, publisher, language,
      file_name, file_size, sha256, created_by, created_at, updated_at)
    VALUES ('b1', NULL, '挽救计划(作者安迪·威尔)科幻新作', '', '', '', 'epub', '', '', '', 'book.epub', 1, '', 'admin', 1, 1),
           ('b2', NULL, '三体（刘慈欣著）', '', '', '', 'epub', '', '', '', 'book.epub', 1, '', 'admin', 2, 2),
           ('b3', NULL, '沙丘', '', '', '', 'epub', '', '', '', 'book.epub', 1, '', 'admin', 3, 3);
  `);
  return { DB };
}

function ctx(env, { user = { username: 'admin', role: 'admin' } } = {}) {
  return { env, data: { user } };
}

test('书名清洗接口返回待清洗数量', async () => {
  const env = makeEnv();
  const response = await onRequestGet(ctx(env));
  const data = await response.json();
  assert.equal(data.ok, true);
  assert.equal(data.total, 3);
  assert.equal(data.pending, 3);
});

test('批量清洗逐本调用 AI，失败保留原书名并继续', async () => {
  const env = makeEnv();
  const calls = [];
  env.AI = {
    async run(_model, request) {
      const text = String(request.messages[0].content);
      calls.push(text);
      const target = (text.match(/待清洗文本：(.+)$/) || [])[1] || '';
      if (target.includes('三体')) return { response: '未识别到书名', usage: {} };
      return { response: target.includes('挽救计划') ? '挽救计划' : '沙丘', usage: { prompt_tokens: 10, completion_tokens: 4 } };
    },
  };
  const response = await onRequestPost({
    ...ctx(env),
    request: new Request('https://example.test/api/ai/title-clean', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 10 }),
    }),
  });
  const data = await response.json();
  assert.equal(data.ok, true);
  assert.equal(data.processed, 3);
  assert.equal(data.results.filter((r) => r.error).length, 1, '三体应识别失败');
  const titles = {};
  for (const row of (await env.DB.prepare('SELECT id, title, title_cleaned_at FROM books').all()).results) {
    titles[row.id] = { title: row.title, cleaned: row.title_cleaned_at };
  }
  assert.equal(titles.b1.title, '挽救计划');
  assert.equal(titles.b2.title, '三体（刘慈欣著）', '识别失败保留原书名');
  assert.equal(titles.b3.title, '沙丘');
  assert.ok(titles.b1.cleaned > 0);
  assert.ok(titles.b3.cleaned > 0);
  assert.equal(titles.b2.cleaned, 0, '识别失败不标记已清洗');
});

test('非管理员不能清洗书名', async () => {
  const env = makeEnv();
  const response = await onRequestPost({
    ...ctx(env, { user: { username: 'member', role: 'member' } }),
    request: new Request('https://example.test/api/ai/title-clean', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 10 }),
    }),
  });
  assert.equal(response.status, 403);
});

test('未配置 AI 时清洗失败但接口不中断', async () => {
  const env = makeEnv();
  delete env.AI;
  const response = await onRequestPost({
    ...ctx(env),
    request: new Request('https://example.test/api/ai/title-clean', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 10 }),
    }),
  });
  const data = await response.json();
  assert.equal(data.ok, true);
  assert.equal(data.processed, 3);
  assert.equal(data.results.filter((r) => r.error).length, 3);
});
