import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost } from '../functions/api/books/[id]/classify.js';
import { createD1 } from './helpers/d1.mjs';
import { encryptApiKey } from '../functions/utils/ai-provider.js';

function seedBook(DB) {
  DB.exec(`
    INSERT INTO users (id, username, display_name, password_hash, role, disabled, created_at, updated_at)
    VALUES ('u1', 'admin', '管理员', 'x', 'admin', 0, 0, 0);
    INSERT INTO books (id, title, author, file_name, created_by, created_at, updated_at)
    VALUES ('b1', '示例书籍H', '金庸', '示例书籍H.epub', 'admin', 1, 1);
  `);
}

test('管理员可对单本书生成标签并查看模型响应', async () => {
  const DB = createD1();
  seedBook(DB);
  const env = { DB, ADMIN_TOKEN: 'test-only-admin-token-placeholder' };
  const encrypted = await encryptApiKey(env, 'provider-secret');
  await DB.prepare(`INSERT INTO ai_provider_config (id, format, base_url, model, encrypted_key, updated_at)
    VALUES (1, 'openai', 'https://provider.example/v1', 'test-model', ?, 0)`).bind(encrypted).run();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (!String(url).includes('chat/completions')) return new Response('{}');
    return new Response(JSON.stringify({
      choices: [{ message: { content: '{"book_id":"b1","book_type":"网文","tag_ids":["BOOK_TYPE_0002","WEB_GENRE_0005","WEB_ELEMENT_0096"],"confidence":{"book_type":0.99,"tag_2":0.92,"tag_3":0.9},"needs_review":false,"review_reason":null,"evidence":["書目资料"]}' } }],
      usage: { prompt_tokens: 15, completion_tokens: 8 },
    }), { status: 200 });
  };
  try {
    const response = await onRequestPost({ env, params: { id: 'b1' }, data: { user: { role: 'admin' } } });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(payload.result.tags, ['网文', '武侠', '复仇']);
    assert.match(payload.result.debug.rawResponse, /WEB_GENRE_0005/);
    assert.equal(payload.result.debug.model, 'openai:test-model');
    const tags = await DB.prepare('SELECT t.name FROM book_standard_tags bt JOIN standard_tags t ON t.tag_id=bt.tag_id WHERE bt.book_id=? ORDER BY t.tag_id').bind('b1').all();
    assert.deepEqual(tags.results.map((tag) => tag.name), ['网文', '复仇', '武侠']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('单本分类接口限制管理员且校验书籍存在', async () => {
  const DB = createD1();
  const denied = await onRequestPost({ env: { DB }, params: { id: 'missing' }, data: { user: { role: 'member' } } });
  assert.equal(denied.status, 403);

  seedBook(DB);
  const missing = await onRequestPost({ env: { DB }, params: { id: 'missing' }, data: { user: { role: 'admin' } } });
  assert.equal(missing.status, 404);
});
