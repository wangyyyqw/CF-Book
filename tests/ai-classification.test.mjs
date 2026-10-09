import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOOK_TAGS, classifyBook, estimateNeurons, normalizeResult } from '../functions/utils/ai-classification.js';
import { createD1 } from './helpers/d1.mjs';
import { encryptKeys } from '../functions/utils/nvidia.js';

function envWithBook() {
  const DB = createD1();
  DB.exec(`
    INSERT INTO users (id, username, display_name, password_hash, role, disabled, created_at, updated_at)
    VALUES ('u1', 'admin', '管理员', 'x', 'admin', 0, 0, 0);
    INSERT INTO books (id, upload_id, title, author, description, cover, format, isbn, publisher, language,
      file_name, file_size, sha256, created_by, created_at, updated_at)
    VALUES ('b1', NULL, '银河英雄传说（套装）插图珍藏版', '田中芳树', '', '', 'epub', '', '早川书房', 'zh',
      'book.epub', 1, '', 'admin', 1, 1);
  `);
  return { DB };
}

test('分类会使用公开书目检索、清理书名、写入三个共享标签并记录用量', async () => {
  const env = envWithBook();
  env.AI = {
    async run() {
      return {
        choices: [{ message: { content: JSON.stringify({ title: '银河英雄传说', tags: ['科幻', '小说', '科幻'] }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      };
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ docs: [{
    title: '银河英雄传说', author_name: ['田中芳树'], publisher: ['早川书房'], subject: ['科幻'], first_publish_year: 1982,
  }] }), { status: 200 });
  try {
    const result = await classifyBook(env, 'b1');
    assert.equal(result.title, '银河英雄传说');
    assert.deepEqual(result.tags, ['科幻', '小说', '其他']);
    const book = await env.DB.prepare('SELECT title FROM books WHERE id = ?').bind('b1').first();
    assert.equal(book.title, '银河英雄传说');
    const tags = await env.DB.prepare('SELECT t.name FROM book_tags bt JOIN tags t ON t.id=bt.tag_id ORDER BY t.id').all();
    assert.deepEqual(tags.results.map((row) => row.name), ['科幻', '小说', '其他']);
    const usage = await env.DB.prepare('SELECT prompt_tokens, completion_tokens, neurons FROM ai_usage').all();
    assert.equal(usage.results.length, 1);
    assert.equal(usage.results[0].prompt_tokens, 100);
    assert.equal(usage.results[0].completion_tokens, 20);
    assert.equal(usage.results[0].neurons, estimateNeurons(100, 20));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('分类以书名作者检索多来源并把短参考信息交给 AI', async () => {
  const env = envWithBook();
  env.BOOK_SEARCH_API_URL = 'https://search.example.test/books?q={query}';
  env.BOOK_SEARCH_API_KEY = 'search-key';
  let prompt = '';
  env.AI = {
    async run(_model, request) {
      prompt = request.messages.find((message) => message.role === 'user').content;
      return {
        choices: [{ message: { content: JSON.stringify({ title: '银河英雄传说', tags: ['科幻', '小说', '太空歌剧'] }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      };
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.startsWith('https://books.googleapis.com/')) {
      return new Response(JSON.stringify({ items: [{ volumeInfo: {
        title: '银河英雄传说', authors: ['田中芳树'], description: '银河帝国与自由行星同盟之间的史诗战争。', categories: ['Science Fiction'], publisher: '早川书房',
      } }] }), { status: 200 });
    }
    if (value.startsWith('https://zh.wikipedia.org/')) {
      return new Response(JSON.stringify({ query: { pages: { '1': {
        title: '银河英雄传说', extract: '田中芳树创作的科幻小说。', categories: [{ title: 'Category:科幻小说' }],
      } } } }), { status: 200 });
    }
    if (value.startsWith('https://openlibrary.org/')) {
      return new Response(JSON.stringify({ docs: [{ title: '银河英雄传说', author_name: ['田中芳树'], subject: ['science fiction'] }] }), { status: 200 });
    }
    if (value.startsWith('https://book.douban.com/')) {
      return new Response(JSON.stringify([{ title: '银河英雄传说', author_name: '田中芳树', year: '1982' }]), { status: 200 });
    }
    if (value.startsWith('https://search.example.test/')) {
      return new Response(JSON.stringify({ results: [{ title: '银河英雄传说', author: '田中芳树', snippet: '科幻小说与太空歌剧。', keywords: ['科幻', '太空歌剧'] }] }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
  try {
    const result = await classifyBook(env, 'b1');
    assert.deepEqual(result.tags, ['科幻', '小说', '其他']);
    assert.match(prompt, /Google Books/);
    assert.match(prompt, /维基/);
    assert.match(prompt, /豆瓣/);
    assert.match(prompt, /搜索 API/);
    assert.match(prompt, /短参考信息/);
    assert.match(prompt, /银河英雄传说/);
    assert.doesNotMatch(prompt, /book\.epub/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('NVIDIA 模型按轮换游标选密钥，并在失败后切换下一把', async () => {
  const env = envWithBook();
  env.ADMIN_TOKEN = 'test-only-admin-token-placeholder';
  const encrypted = await encryptKeys(env, ['nvapi-first-secret', 'nvapi-second-secret']);
  await env.DB.prepare('INSERT INTO nvidia_ai_config (id, model, encrypted_keys, next_key, updated_at) VALUES (1, ?, ?, 0, 0)')
    .bind('test/model', encrypted).run();
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    if (!options?.headers?.Authorization) return new Response('{}', { status: 200 });
    const key = options.headers.Authorization;
    calls.push(key);
    if (key.endsWith('first-secret')) return new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: '银河英雄传说', tags: ['科幻', '小说', '其他'] }) } }], usage: { prompt_tokens: 20, completion_tokens: 10 } }), { status: 200 });
  };
  try {
    const result = await classifyBook(env, 'b1');
    assert.equal(result.tags[0], '科幻');
    assert.deepEqual(calls, ['Bearer nvapi-first-secret', 'Bearer nvapi-second-secret']);
    assert.equal((await env.DB.prepare('SELECT next_key FROM nvidia_ai_config WHERE id=1').first()).next_key, 1);
    const usage = await env.DB.prepare('SELECT model, neurons FROM ai_usage').first();
    assert.equal(usage.model, 'nvidia:test/model');
    assert.equal(usage.neurons, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('NVIDIA 调用失败时数据库错误记录不会泄漏密钥', async () => {
  const env = envWithBook();
  env.ADMIN_TOKEN = 'test-only-admin-token-placeholder';
  const encrypted = await encryptKeys(env, ['nvapi-hidden-secret']);
  await env.DB.prepare('INSERT INTO nvidia_ai_config (id, model, encrypted_keys, next_key, updated_at) VALUES (1, ?, ?, 0, 0)')
    .bind('test/model', encrypted).run();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('https://integrate.api.nvidia.com/')) {
      return new Response(JSON.stringify({ error: { message: 'request rejected' } }), { status: 401 });
    }
    return new Response('{}', { status: 200 });
  };
  try {
    await assert.rejects(classifyBook(env, 'b1'), /所有密钥请求失败/);
    const row = await env.DB.prepare('SELECT error FROM ai_classifications WHERE book_id=?').bind('b1').first();
    assert.doesNotMatch(row.error, /nvapi-hidden-secret/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('AI 返回占位书名时保留原书名并执行安全清理', async () => {
  const env = envWithBook();
  env.AI = { async run() {
    return { choices: [{ message: { content: JSON.stringify({ title: '清理后的书名', tags: ['文学', '小说', '历史'] }) } }], usage: {} };
  } };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ docs: [] }), { status: 200 });
  try {
    const result = await classifyBook(env, 'b1');
    assert.equal(result.title, '银河英雄传说');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('分类兼容思考文本包裹的 JSON 和公开书目标签', () => {
  const result = normalizeResult('<think>先分析书目</think>\n```json\n{"title":"银河英雄传说（上下册）","tags":["科幻"]}\n```', '银河英雄传说（套装）', '田中芳树', { subjects: ['science fiction'] });
  assert.equal(result.title, '银河英雄传说');
  assert.deepEqual(result.tags, ['科幻', '小说', '其他']);
});

test('金庸作品优先加入武侠标签', () => {
  const result = normalizeResult(
    JSON.stringify({ title: '示例书籍H', tags: ['文学', '历史', '其他'] }),
    '示例书籍H',
    '金庸',
    { subjects: ['fiction'] },
  );
  assert.deepEqual(result.tags, ['武侠', '历史', '小说']);
});

test('具体标签优先于文学和其他等泛标签', () => {
  const result = normalizeResult(
    JSON.stringify({ title: '银河英雄传说', tags: ['文学', '小说', '科幻'] }),
    '银河英雄传说',
    '田中芳树',
    { subjects: ['science fiction'] },
  );
  assert.deepEqual(result.tags, ['科幻', '小说', '其他']);
});

test('受控标签词库包含分层题材、学科和受众标签', () => {
  for (const tag of ['武侠', '仙侠', '历史小说', '编程', '人类学', '青少年', '纪实文学']) {
    assert.ok(BOOK_TAGS.includes(tag), `${tag} 应在受控标签词库中`);
  }
});
