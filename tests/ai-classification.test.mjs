import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyBook, estimateNeurons, normalizeResult } from '../functions/utils/ai-classification.js';
import { createD1 } from './helpers/d1.mjs';

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
  assert.deepEqual(result.tags, ['科幻', '其他', '小说']);
});

test('金庸作品优先加入武侠标签', () => {
  const result = normalizeResult(
    JSON.stringify({ title: '示例书籍H', tags: ['文学', '历史', '其他'] }),
    '示例书籍H',
    '金庸',
    { subjects: ['fiction'] },
  );
  assert.deepEqual(result.tags, ['武侠', '文学', '历史']);
});
