import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanBookTitle,
  isTransientAiError,
  normalizeCleanedTitle,
  retryWithBackoff,
} from '../functions/utils/ai-classification.js';
import { createD1 } from './helpers/d1.mjs';
import { encryptApiKey } from '../functions/utils/ai-provider.js';

function envWithBook(title = '挽救计划(《火星救援》作者安迪·威尔全新力作)') {
  const DB = createD1();
  DB.exec(`
    INSERT INTO users (id, username, display_name, password_hash, role, disabled, created_at, updated_at)
    VALUES ('u1', 'admin', '管理员', 'x', 'admin', 0, 0, 0);
    INSERT INTO uploads (upload_id, filename, mime, total_size, chunk_size, total_chunks, sha256, status, owner, created_at, updated_at)
    VALUES ('up1', 'book.epub', 'application/epub+zip', 25, 8, 4, '', 'completed', 'admin', 1, 1);
    INSERT INTO chunks (upload_id, idx, size, status, updated_at) VALUES ('up1', 0, 10, 'uploaded', 1), ('up1', 1, 10, 'uploaded', 1), ('up1', 2, 5, 'uploaded', 1);
    INSERT INTO books (id, upload_id, title, author, description, cover, format, isbn, publisher, language,
      file_name, file_size, sha256, created_by, created_at, updated_at)
    VALUES ('b1', 'up1', '${title}', '', '', '', 'epub', '', '', '', 'book.epub', 25, '', 'admin', 1, 1);
  `);
  return { DB };
}

test('书名清洗只保留主书名并去掉宣传文案', () => {
  assert.equal(normalizeCleanedTitle('挽救计划'), '挽救计划');
  assert.equal(normalizeCleanedTitle('沙丘'), '沙丘');
  assert.equal(normalizeCleanedTitle('三体'), '三体');
  assert.equal(normalizeCleanedTitle('《沙丘》（电影纪念版）'), '沙丘');
  assert.equal(normalizeCleanedTitle('"挽救计划"'), '挽救计划');
  assert.equal(normalizeCleanedTitle('书名：挽救计划'), '挽救计划');
  assert.equal(normalizeCleanedTitle('未识别到书名'), null);
  assert.equal(normalizeCleanedTitle(''), null);
});

test('上传完成后 AI 清洗书名并保存，不触碰 Telegram 分块记录', async () => {
  const env = envWithBook();
  env.AI = { async run() { return { response: '挽救计划', usage: { prompt_tokens: 20, completion_tokens: 6 } }; } };
  const result = await cleanBookTitle(env, 'b1');
  assert.equal(result.title, '挽救计划');
  const book = await env.DB.prepare('SELECT title FROM books WHERE id = ?').bind('b1').first();
  assert.equal(book.title, '挽救计划');
  const chunks = await env.DB.prepare('SELECT COUNT(*) AS count FROM chunks').first();
  assert.equal(chunks.count, 3, '清洗书名不应改动 Telegram 分块索引');
  const usage = await env.DB.prepare('SELECT prompt_tokens, completion_tokens, status FROM ai_usage').all();
  assert.equal(usage.results.length, 1);
  assert.equal(usage.results[0].status, 'completed');
});

test('AI 无法识别书名时抛错并保留原书名', async () => {
  const env = envWithBook();
  env.AI = { async run() { return { response: '未识别到书名', usage: {} }; } };
  await assert.rejects(cleanBookTitle(env, 'b1'), /未能识别/);
  const book = await env.DB.prepare('SELECT title FROM books WHERE id = ?').bind('b1').first();
  assert.match(book.title, /挽救计划/);
});

test('自定义 OpenAI/Anthropic Provider 也用于书名清洗', async () => {
  for (const format of ['openai', 'anthropic']) {
    const env = envWithBook('三体（刘慈欣著，地球往事三部曲）');
    env.ADMIN_TOKEN = 'test-only-admin-token-placeholder';
    const encrypted = await encryptApiKey(env, `${format}-secret`);
    await env.DB.prepare(`INSERT INTO ai_provider_config (id, format, base_url, model, encrypted_key, updated_at)
      VALUES (1, ?, 'https://provider.example/v1', 'test-model', ?, 0)`).bind(format, encrypted).run();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes('chat/completions') || String(url).includes('messages')) {
        const text = '三体';
        return format === 'openai'
          ? new Response(JSON.stringify({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 4 } }), { headers: { 'Content-Type': 'application/json' } })
          : new Response(JSON.stringify({
            id: 'msg_test', type: 'message', role: 'assistant', model: 'test-model',
            content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 4 },
          }), { headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('{}');
    };
    try {
      const result = await cleanBookTitle(env, 'b1');
      assert.equal(result.title, '三体');
      const book = await env.DB.prepare('SELECT title FROM books WHERE id = ?').bind('b1').first();
      assert.equal(book.title, '三体');
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
});

test('瞬时错误按指数退避自动重跑，成功后返回书名', async () => {
  const sleeps = [];
  let attempts = 0;
  const result = await retryWithBackoff(
    async () => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error('Service temporarily unavailable');
        error.statusCode = 503;
        throw error;
      }
      return '西行漫记';
    },
    { sleep: async (ms) => sleeps.push(ms), random: () => 1 }
  );
  assert.equal(result, '西行漫记');
  assert.equal(attempts, 3, '应在第 3 次尝试成功');
  assert.deepEqual(sleeps, [1500, 4000], '按递增间隔退避');
});

test('重试用尽后抛出最后一次错误', async () => {
  let attempts = 0;
  await assert.rejects(
    retryWithBackoff(
      async () => {
        attempts += 1;
        const error = new Error('timeout');
        error.name = 'TimeoutError';
        throw error;
      },
      { sleep: async () => {}, random: () => 0 }
    ),
    /timeout/
  );
  assert.equal(attempts, 3, '初始 1 次 + 2 次重试');
});

test('确定性失败不重试，避免白耗额度', async () => {
  let attempts = 0;
  await assert.rejects(
    retryWithBackoff(
      async () => {
        attempts += 1;
        const error = new Error('AI 未能识别书名');
        error.isRetryable = false;
        throw error;
      },
      { sleep: async () => {}, random: () => 0 }
    ),
    /未能识别/
  );
  assert.equal(attempts, 1, '不可重试错误只调用一次');
});

test('isTransientAiError 只认上游抖动类错误', () => {
  assert.equal(isTransientAiError(Object.assign(new Error('x'), { statusCode: 503 })), true);
  assert.equal(isTransientAiError(Object.assign(new Error('x'), { statusCode: 429 })), true);
  assert.equal(isTransientAiError(Object.assign(new Error('x'), { isRetryable: true })), true);
  assert.equal(isTransientAiError(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), true);
  assert.equal(isTransientAiError(Object.assign(new Error('AI 未能识别书名'), { isRetryable: false })), false);
  assert.equal(isTransientAiError(Object.assign(new Error('书籍不存在'), { statusCode: 404 })), false);
  assert.equal(isTransientAiError(null), false);
});

test('清洗遇到上游 503 会退避重跑并最终写入书名', async () => {
  const env = envWithBook();
  let calls = 0;
  env.AI = {
    async run() {
      calls += 1;
      if (calls < 2) {
        const error = new Error('Service temporarily unavailable');
        error.statusCode = 503;
        throw error;
      }
      return { response: '挽救计划', usage: { prompt_tokens: 10, completion_tokens: 4 } };
    },
  };
  const result = await cleanBookTitle(env, 'b1', {
    retry: (task) => retryWithBackoff(task, { sleep: async () => {}, random: () => 0 }),
  });
  assert.equal(result.title, '挽救计划');
  assert.equal(calls, 2, '第一次 503 后重试成功');
  const book = await env.DB.prepare('SELECT title FROM books WHERE id = ?').bind('b1').first();
  assert.equal(book.title, '挽救计划');
});
