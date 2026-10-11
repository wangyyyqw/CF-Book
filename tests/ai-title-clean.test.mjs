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

test('分批清洗不会因已清洗书籍离开集合而跳过书目', async () => {
  const DB = createD1();
  DB.exec(`INSERT INTO users (id, username, display_name, password_hash, role, disabled, created_at, updated_at)
    VALUES ('u1', 'admin', '管理员', 'x', 'admin', 0, 0, 0);`);
  const rows = [];
  for (let i = 1; i <= 25; i += 1) {
    rows.push(`('b${i}', NULL, '书名${i}', '', '', '', 'epub', '', '', '', 'f.epub', 1, '', 'admin', ${i}, ${i})`);
  }
  DB.exec(`INSERT INTO books (id, upload_id, title, author, description, cover, format, isbn, publisher, language,
    file_name, file_size, sha256, created_by, created_at, updated_at) VALUES ${rows.join(',')};`);
  const env = { DB };
  env.AI = {
    async run(_model, request) {
      const target = (String(request.messages[0].content).match(/待清洗文本：(.+)$/) || [])[1] || '';
      return { response: target, usage: {} };
    },
  };
  // 复刻管理页循环：始终从头取，并用 exclude 跳过本轮失败项。
  let processed = 0;
  const attempted = [];
  let guard = 0;
  while (guard < 20) {
    guard += 1;
    const response = await onRequestPost({
      ...ctx(env),
      request: new Request('https://example.test/api/ai/title-clean', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 10, exclude: attempted }),
      }),
    });
    const data = await response.json();
    processed += data.processed;
    attempted.push(...data.results.filter((r) => r.error).map((r) => r.bookId));
    if (data.processed < data.batchLimit) break;
  }
  assert.equal(processed, 25, '25 本应全部被处理');
  const remaining = await env.DB.prepare('SELECT COUNT(*) AS count FROM books WHERE title_cleaned_at = 0').first();
  assert.equal(remaining.count, 0, '不应有书目被 offset 跳过');
});

test('exclude 参数会跳过本轮已失败的书目', async () => {
  const env = makeEnv();
  const seen = [];
  env.AI = {
    async run(_model, request) {
      const target = (String(request.messages[0].content).match(/待清洗文本：(.+)$/) || [])[1] || '';
      seen.push(target);
      return { response: '未识别到书名', usage: {} };
    },
  };
  const response = await onRequestPost({
    ...ctx(env),
    request: new Request('https://example.test/api/ai/title-clean', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 10, exclude: ['b1', 'b2'] }),
    }),
  });
  const data = await response.json();
  assert.equal(data.processed, 1, '只剩 b3 可尝试');
  assert.equal(data.results[0].bookId, 'b3');
  assert.ok(!seen.some((text) => text.includes('挽救计划')), '被排除的 b1 不应再调用 AI');
});

test('清洗响应返回剩余数量与 cleaned 计数', async () => {
  const env = makeEnv();
  env.AI = {
    async run(_model, request) {
      const target = (String(request.messages[0].content).match(/待清洗文本：(.+)$/) || [])[1] || '';
      return { response: target, usage: {} };
    },
  };
  const response = await onRequestPost({
    ...ctx(env),
    request: new Request('https://example.test/api/ai/title-clean', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 2 }),
    }),
  });
  const data = await response.json();
  assert.equal(data.cleaned, 2);
  assert.equal(data.pending, 1, '3 本中清洗 2 本后剩 1 本');
  assert.equal(data.hasMore, true);
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

test('配置自定义 Provider 时每次只清洗一本书', async () => {
  const env = makeEnv();
  // 配置自定义 Provider：含冒号的 model 不计 Neurons，必须靠批大小限流
  await env.DB.prepare(`INSERT INTO ai_provider_config (id, format, base_url, model, encrypted_key, updated_at)
    VALUES (1, 'openai', 'https://provider.example/v1', 'model', 'cipher', 0)`).run();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('chat/completions')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: '挽救计划' } }], usage: { prompt_tokens: 10, completion_tokens: 4 } }), { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}');
  };
  try {
    const response = await onRequestPost({
      ...ctx(env),
      request: new Request('https://example.test/api/ai/title-clean', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 10 }),
      }),
    });
    const data = await response.json();
    assert.equal(data.batchLimit, 1, '自定义 Provider 下批大小应被压到 1');
    assert.equal(data.processed, 1, '单次请求只处理一本书');
  } finally {
    globalThis.fetch = originalFetch;
  }
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
