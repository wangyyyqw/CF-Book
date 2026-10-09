import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyBook, estimateNeurons, normalizeResult } from '../functions/utils/ai-classification.js';
import { createD1 } from './helpers/d1.mjs';
import { encryptApiKey } from '../functions/utils/ai-provider.js';

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

test('分类会用公开资料辅助生成标签并写入共享标签及用量', async () => {
  const env = envWithBook();
  env.AI = {
    async run() {
      return {
        choices: [{ message: { content: '{"book_id":"b1","book_type":"出版书","tag_ids":["BOOK_TYPE_0001","PUB_FIELD_0049","PUB_TOPIC_0088"],"confidence":{"book_type":0.99,"tag_2":0.92,"tag_3":0.9},"needs_review":false,"review_reason":null,"evidence":["书目资料"]}' } }],
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
    assert.deepEqual(result.tags, ['出版书', '中国文学', '科幻文学']);
    const book = await env.DB.prepare('SELECT title FROM books WHERE id = ?').bind('b1').first();
    assert.equal(book.title, '银河英雄传说');
    const tags = await env.DB.prepare('SELECT t.name FROM book_standard_tags bt JOIN standard_tags t ON t.tag_id=bt.tag_id ORDER BY t.tag_id').all();
    assert.deepEqual(tags.results.map((row) => row.name), ['出版书', '中国文学', '科幻文学']);
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
        choices: [{ message: { content: '{"book_id":"b1","book_type":"出版书","tag_ids":["BOOK_TYPE_0001","PUB_FIELD_0049","PUB_TOPIC_0088"],"confidence":{"book_type":0.99,"tag_2":0.92,"tag_3":0.9},"needs_review":false,"review_reason":null,"evidence":["书目资料"]}' } }],
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
    assert.deepEqual(result.tags, ['出版书', '中国文学', '科幻文学']);
    assert.match(prompt, /"summary"/);
    assert.match(prompt, /史诗战争/);
    assert.match(prompt, /只能从 candidates 中选择 tag_id/);
    assert.match(prompt, /pub_field/);
    assert.match(prompt, /银河英雄传说/);
    assert.match(prompt, /BOOK_TYPE_0001/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('分类通过 OpenAI-compatible 和 Anthropic SDK 调用所选模型并保存三个标签', async () => {
  for (const format of ['openai', 'anthropic']) {
    const env = envWithBook();
    env.ADMIN_TOKEN = 'test-only-admin-token-placeholder';
    const encrypted = await encryptApiKey(env, `${format}-secret`);
    await env.DB.prepare(`INSERT INTO ai_provider_config (id, format, base_url, model, encrypted_key, updated_at)
      VALUES (1, ?, 'https://provider.example/v1', 'test-model', ?, 0)`).bind(format, encrypted).run();
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options = {}) => {
      const target = new URL(url);
      calls.push({ target, options });
      if (target.hostname === 'openlibrary.org') return new Response('{"docs":[]}');
      if (target.hostname === 'books.googleapis.com' || target.hostname.endsWith('wikipedia.org') || target.hostname === 'book.douban.com') return new Response('{}');
      if (format === 'openai') return new Response(JSON.stringify({
        choices: [{ message: { content: '{"book_id":"b1","book_type":"出版书","tag_ids":["BOOK_TYPE_0001","PUB_FIELD_0049","PUB_TOPIC_0088"],"confidence":{"book_type":0.99,"tag_2":0.92,"tag_3":0.9},"needs_review":false,"review_reason":null,"evidence":["书目资料"]}' } }],
        usage: { prompt_tokens: 23, completion_tokens: 9 },
      }), { headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({
        id: 'msg_test', type: 'message', role: 'assistant', model: 'test-model',
        content: [{ type: 'text', text: '{"book_id":"b1","book_type":"出版书","tag_ids":["BOOK_TYPE_0001","PUB_FIELD_0049","PUB_TOPIC_0088"],"confidence":{"book_type":0.99,"tag_2":0.92,"tag_3":0.9},"needs_review":false,"review_reason":null,"evidence":["书目资料"]}' }],
        stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 23, output_tokens: 9 },
      }), { headers: { 'Content-Type': 'application/json' } });
    };
    try {
      const result = await classifyBook(env, 'b1', { includeDebug: true });
      assert.deepEqual(result.tags, ['出版书', '中国文学', '科幻文学']);
      assert.equal(result.debug.model, `${format}:test-model`);
      const request = calls.find(({ target }) => target.hostname === 'provider.example');
      assert.ok(request);
      assert.equal(request.target.pathname, format === 'openai' ? '/v1/chat/completions' : '/v1/messages');
      assert.equal(JSON.parse(request.options.body).max_tokens, 1800);
      if (format === 'openai') {
      assert.equal(request.options.headers.authorization, 'Bearer openai-secret');
      assert.equal(JSON.parse(request.options.body).model, 'test-model');
      } else {
        assert.equal(request.options.headers['x-api-key'], 'anthropic-secret');
        assert.equal(JSON.parse(request.options.body).model, 'test-model');
      }
      const usage = await env.DB.prepare('SELECT prompt_tokens, completion_tokens FROM ai_usage').first();
      assert.equal(usage.prompt_tokens, 23);
      assert.equal(usage.completion_tokens, 9);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
});

test('自定义 OpenAI 模型把 JSON 放在 reasoning 时仍能读取并保存标准标签', async () => {
  const env = envWithBook();
  env.ADMIN_TOKEN = 'test-only-admin-token-placeholder';
  const encrypted = await encryptApiKey(env, 'provider-secret');
  await env.DB.prepare(`INSERT INTO ai_provider_config (id, format, base_url, model, encrypted_key, updated_at)
    VALUES (1, 'openai', 'https://provider.example/v1', 'test-model', ?, 0)`).bind(encrypted).run();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = new URL(url);
    if (target.hostname === 'openlibrary.org' || target.hostname === 'books.googleapis.com' || target.hostname.endsWith('wikipedia.org') || target.hostname === 'book.douban.com') return new Response('{}');
    return new Response(JSON.stringify({
      choices: [{ message: { content: '', reasoning_content: '{"book_id":"b1","book_type":"出版书","tag_ids":["BOOK_TYPE_0001","PUB_FIELD_0049","PUB_TOPIC_0088"],"confidence":{"book_type":0.99,"tag_2":0.92,"tag_3":0.9},"needs_review":false,"review_reason":null,"evidence":["书目资料"]}' } }],
      usage: { prompt_tokens: 23, completion_tokens: 9 },
    }), { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const result = await classifyBook(env, 'b1');
    assert.deepEqual(result.tags, ['出版书', '中国文学', '科幻文学']);
    const saved = await env.DB.prepare('SELECT COUNT(*) AS count FROM book_standard_tags WHERE book_id=?').bind('b1').first();
    assert.equal(saved.count, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('AI 要求人工审核时不写标签', async () => {
  const env = envWithBook();
  env.AI = { async run() { return { choices: [{ message: { content: '{}' } }], usage: {} }; } };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  try {
    await assert.rejects(classifyBook(env, 'b1'), /需要人工审核/);
    const tags = await env.DB.prepare('SELECT COUNT(*) AS count FROM book_standard_tags WHERE book_id=?').bind('b1').first();
    assert.equal(tags.count, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('AI 返回占位书名时保留原书名并执行安全清理', async () => {
  const env = envWithBook();
  env.AI = { async run() {
    return { choices: [{ message: { content: '{"book_id":"b1","book_type":"出版书","tag_ids":["BOOK_TYPE_0001","PUB_FIELD_0049","PUB_TOPIC_0088"],"confidence":{"book_type":0.99,"tag_2":0.92,"tag_3":0.9},"needs_review":false,"review_reason":null,"evidence":["书目资料"]}' } }], usage: {} };
  } };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ docs: [] }), { status: 200 });
  try {
    const result = await classifyBook(env, 'b1');
    assert.equal(result.title, '银河英雄传说');
    assert.deepEqual(result.tags, ['出版书', '中国文学', '科幻文学']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('标签解析严格要求预期 book_id、ID 维度顺序和审核状态', () => {
  const result = normalizeResult('{"book_id":"b1","book_type":"出版书","tag_ids":["BOOK_TYPE_0001","PUB_FIELD_0049","PUB_TOPIC_0088"],"confidence":{"book_type":0.99,"tag_2":0.92,"tag_3":0.9},"needs_review":false,"review_reason":null,"evidence":["书目资料"]}', 'b1', '银河英雄传说（套装）', '田中芳树');
  assert.equal(result.title, '银河英雄传说');
  assert.deepEqual(result.tagIds, ['BOOK_TYPE_0001', 'PUB_FIELD_0049', 'PUB_TOPIC_0088']);
  assert.throws(() => normalizeResult('{}', 'b1', '书名'), /审核/);
});

test('最终拒绝错误书籍 ID、不完整结果或需要审核的标签', () => {
  for (const invalid of [
    JSON.stringify({book_id:'b1',book_type:'出版书',tag_ids:['BOOK_TYPE_0001','PUB_FIELD_0049','PUB_FIELD_0049'],confidence:{book_type:1,tag_2:1,tag_3:1},needs_review:false}),
    JSON.stringify({book_id:'wrong',book_type:'出版书',tag_ids:['BOOK_TYPE_0001','PUB_FIELD_0049','PUB_TOPIC_0088'],confidence:{book_type:1,tag_2:1,tag_3:1},needs_review:false}),
    JSON.stringify({book_id:'b1',book_type:'出版书',tag_ids:[],needs_review:true,review_reason:'证据不足'}),
  ]) {
    assert.throws(() => normalizeResult(invalid, 'b1', '病菌与健康'));
  }
});

test('标准标签 JSON 可从包含分析文字的 reasoning 中提取目标对象', () => {
  const response = `We need answer only JSON. Example: {"book_id":"other","tag_ids":[]} Final: {"book_id":"b1","book_type":"出版书","tag_ids":["BOOK_TYPE_0001","PUB_FIELD_0045","PUB_TOPIC_0071"],"confidence":{"book_type":0.9,"tag_2":0.9,"tag_3":0.9},"needs_review":false,"review_reason":null,"evidence":["作品内容"]}`;
  const result = normalizeResult(response, 'b1', '示例书籍F', '马克·布洛赫');
  assert.deepEqual(result.tagIds, ['BOOK_TYPE_0001', 'PUB_FIELD_0045', 'PUB_TOPIC_0071']);
});
