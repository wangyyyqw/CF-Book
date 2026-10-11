import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPut } from '../functions/api/books/[id]/tags.js';
import { createD1 } from './helpers/d1.mjs';

function makeEnv() {
  const DB = createD1();
  DB.exec(`INSERT INTO books (id, title, created_by, created_at, updated_at)
           VALUES ('b1', '示例书', 'admin', 1, 1);`);
  return { DB };
}

function ctx(env, user, body) {
  return {
    env,
    params: { id: 'b1' },
    data: { user },
    request: new Request('https://example.com/api/books/b1/tags', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  };
}

const VALID_TAGS = ['BOOK_TYPE_0001', 'PUB_FIELD_0049', 'PUB_TOPIC_0088'];

test('成员不能再直接整理共享标准标签，统一收敛到管理员', async () => {
  const env = makeEnv();
  const res = await onRequestPut(ctx(env, { id: 'u2', username: 'member', role: 'member' }, { tagIds: VALID_TAGS }));
  assert.equal(res.status, 403);
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM book_standard_tags WHERE book_id = ?').bind('b1').first();
  assert.equal(Number(count.n), 0, '被拒绝时不应写入任何标签');
});

test('管理员仍可通过该端点整理标准标签', async () => {
  const env = makeEnv();
  const res = await onRequestPut(ctx(env, { id: 'u1', username: 'admin', role: 'admin' }, { tagIds: VALID_TAGS }));
  assert.equal(res.status, 200);
  const rows = await env.DB.prepare('SELECT tag_id FROM book_standard_tags WHERE book_id = ? ORDER BY tag_id').bind('b1').all();
  assert.deepEqual(rows.results.map((r) => r.tag_id).sort(), [...VALID_TAGS].sort());
});
