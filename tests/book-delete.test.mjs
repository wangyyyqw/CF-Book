import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestDelete } from '../functions/api/books/[id].js';

const BOOK = {
  id: 'b1',
  upload_id: 'up1',
  title: '示例书籍A',
  cover: '/api/covers/b1.jpg',
};
const CHUNKS = [
  { idx: 0, tg_message_id: 101, tg_chat_id: '-1004325137748' },
  { idx: 1, tg_message_id: 102, tg_chat_id: '-1004325137748' },
];

function fakeEnv() {
  const sqlLog = [];
  const db = {
    prepare(sql) {
      const stmt = {
        params: [],
        bind(...params) {
          stmt.params = params;
          return stmt;
        },
        async first() {
          if (!sql.includes('FROM books WHERE id')) return null;
          return stmt.params[0] === BOOK.id ? BOOK : null;
        },
        async all() {
          return { results: sql.includes('FROM chunks WHERE upload_id') ? CHUNKS : [] };
        },
        async run() {
          sqlLog.push({ sql, params: stmt.params });
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  const covers = {
    deleted: [],
    async delete(key) {
      covers.deleted.push(key);
    },
  };
  const env = { DB: db, COVERS: covers, TG_BOT_TOKEN: 'test-token', TG_CHAT_ID: '-1004325137748' };
  return { env, covers, sqlLog };
}

function context(env, user = { id: 'u1', username: 'admin', role: 'admin' }) {
  return { env, params: { id: 'b1' }, data: { user } };
}

// 拦截 Telegram 请求，避免测试打真实网络
async function withTelegram(responder, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), body });
    const reply = responder(body, calls.length);
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

test('删除书籍会清掉封面、Telegram 分块消息与全部 D1 记录', async () => {
  const { env, covers, sqlLog } = fakeEnv();

  await withTelegram(() => ({ status: 200, body: { ok: true, result: true } }), async (calls) => {
    const res = await onRequestDelete(context(env));
    assert.equal(res.status, 200);

    assert.deepEqual(covers.deleted, ['covers/b1.jpg']);

    assert.equal(calls.length, 2, '每个分块都该发一次 deleteMessage');
    assert.ok(calls.every((c) => c.url.includes('/deleteMessage')));
    assert.deepEqual(
      calls.map((c) => c.body.message_id),
      [101, 102]
    );
    assert.ok(calls.every((c) => c.body.chat_id === '-1004325137748'));

    const deleted = sqlLog.map((entry) => entry.sql);
    assert.ok(deleted.some((sql) => sql === 'DELETE FROM chunks WHERE upload_id = ?'));
    assert.ok(deleted.some((sql) => sql === 'DELETE FROM uploads WHERE upload_id = ?'));
    assert.ok(deleted.some((sql) => sql === 'DELETE FROM book_user_state WHERE book_id = ?'));
    assert.ok(deleted.some((sql) => sql === 'DELETE FROM book_tags WHERE book_id = ?'));
    assert.ok(deleted.some((sql) => sql === 'DELETE FROM book_standard_tags WHERE book_id = ?'));
    assert.ok(deleted.some((sql) => sql === 'DELETE FROM shelf_books WHERE book_id = ?'), '应清理书架成员关系');
    assert.ok(deleted.some((sql) => sql === 'DELETE FROM ai_classifications WHERE book_id = ?'), '应清理 AI 分类记录');
    assert.ok(deleted.some((sql) => sql === 'DELETE FROM books WHERE id = ?'));
  });
});

test('Telegram 删不掉时中止，不留下「记录没了但文件还在」的孤儿', async () => {
  const { env, sqlLog } = fakeEnv();

  await withTelegram(
    () => ({ status: 400, body: { ok: false, description: 'Bad Request: not enough rights' } }),
    async () => {
      const res = await onRequestDelete(context(env));
      assert.equal(res.status, 502);
      const payload = await res.json();
      assert.match(payload.error, /第 1 块/);
      assert.equal(sqlLog.length, 0, '失败时不该删任何 D1 记录');
    }
  );
});

test('消息本就已不存在时视为已清理，继续完成删除', async () => {
  const { env, sqlLog } = fakeEnv();

  await withTelegram(
    () => ({ status: 400, body: { ok: false, description: 'Bad Request: message to delete not found' } }),
    async () => {
      const res = await onRequestDelete(context(env));
      assert.equal(res.status, 200);
      assert.ok(sqlLog.some((entry) => entry.sql === 'DELETE FROM books WHERE id = ?'));
    }
  );
});

test('非管理员不能删除书籍', async () => {
  const { env, covers, sqlLog } = fakeEnv();
  const res = await onRequestDelete(context(env, { id: 'u2', username: 'member', role: 'member' }));
  assert.equal(res.status, 403);
  assert.equal(covers.deleted.length, 0);
  assert.equal(sqlLog.length, 0);
});

test('书籍不存在时返回 404', async () => {
  const { env } = fakeEnv();
  const res = await onRequestDelete({ env, params: { id: 'missing' }, data: { user: { role: 'admin' } } });
  assert.equal(res.status, 404);
});
