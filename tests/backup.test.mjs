import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet as exportBackup } from '../functions/api/backup/export.js';
import { onRequestPost as previewBackup } from '../functions/api/backup/preview.js';
import { onRequestPost as restoreBackup } from '../functions/api/backup/restore.js';
import { encryptBackup, decryptBackup, exportTables } from '../functions/utils/backup.js';
import { createD1 } from './helpers/d1.mjs';

function makeEnv({ withData = true } = {}) {
  const DB = createD1();
  DB.exec(
    `INSERT INTO users (id, username, display_name, password_hash, role, disabled, created_at, updated_at)
     VALUES ('u1', 'admin', '管理员', 'hash', 'admin', 0, 1, 1)`
  );
  if (withData) {
    DB.exec(
      `INSERT INTO uploads
         (upload_id, filename, mime, total_size, chunk_size, total_chunks, sha256, status, owner,
          verified_at, verify_result, created_at, updated_at)
       VALUES ('up1', 'book.epub', 'application/epub+zip', 20, 10, 2, 'abc', 'completed', 'admin', 0, '', 1, 1);
       INSERT INTO chunks (upload_id, idx, size, sha256, status, tg_chat_id, tg_message_id, tg_file_id, error, retries, updated_at)
       VALUES ('up1', 0, 10, 'h0', 'uploaded', '-100', 11, 'FILE0', '', 0, 1),
              ('up1', 1, 10, 'h1', 'uploaded', '-100', 12, 'FILE1', '', 0, 1);
       INSERT INTO books (id, upload_id, title, author, description, cover, format, isbn, publisher, language,
                          file_name, file_size, sha256, created_by, created_at, updated_at)
       VALUES ('b1', 'up1', '书一', '作者', '简介', '', 'epub', '', '', '', 'book.epub', 20, 'abc', 'admin', 1, 1);
       INSERT INTO book_user_state (book_id, user_id, rating, status, is_favorite, updated_at)
       VALUES ('b1', 'u1', 9, 'read', 1, 1);
       INSERT INTO book_standard_tags (book_id, tag_id) VALUES ('b1', 'BOOK_TYPE_0001');`
    );
  }
  return { DB, BACKUP_KEY: '测试密钥-test-key' };
}

function ctx(env, { method = 'POST', body, url = 'https://example.com/api/backup/preview' } = {}) {
  return {
    env,
    data: { user: { id: 'u1', username: 'admin', role: 'admin' } },
    request: new Request(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }),
  };
}

async function exportPayload(env, query = '') {
  const res = await exportBackup(ctx(env, { method: 'GET', url: `https://example.com/api/backup/export${query}` }));
  return JSON.parse(await res.text());
}

test('导出包含书目、账号、标签、评分状态与 Telegram 分块索引', async () => {
  const env = makeEnv();
  const backup = await exportTables(env);
  assert.equal(backup.format, 'cf-book-backup');
  assert.equal(backup.tables.books.length, 1);
  assert.equal(backup.tables.users.length, 1);
  assert.equal(backup.tables.uploads.length, 1);
  assert.equal(backup.tables.chunks.length, 2, '必须带上 Telegram 原文件的索引');
  assert.equal(backup.tables.chunks[0].tg_file_id, 'FILE0');
  assert.equal(backup.tables.book_user_state[0].rating, 9);
  assert.equal(backup.tables.books[0].title_cleaned_at, 0, '备份应包含书名清洗标记');
  assert.equal(backup.counts.chunks, 2);
});

test('默认导出为加密信封，只有正确的 BACKUP_KEY 能解开', async () => {
  const env = makeEnv();
  const envelope = await exportPayload(env);
  assert.equal(envelope.encrypted, true);
  assert.equal(envelope.cipher.name, 'AES-GCM');
  assert.equal(envelope.tables, undefined, '加密备份不应包含明文数据');

  const plain = await decryptBackup(envelope, env.BACKUP_KEY);
  assert.equal(plain.tables.books[0].title, '书一');

  await assert.rejects(() => decryptBackup(envelope, '错误的密钥'), /解密失败/);
});

test('缺少 BACKUP_KEY 时拒绝生成加密备份', async () => {
  const env = { DB: makeEnv().DB };
  const res = await exportBackup(ctx(env, { method: 'GET', url: 'https://example.com/api/backup/export' }));
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /BACKUP_KEY/);
});

test('恢复前预览给出备份内条数与当前库条数', async () => {
  const env = makeEnv();
  const backup = await exportTables(env);
  env.DB.exec("DELETE FROM books; DELETE FROM chunks;");

  const res = await previewBackup(ctx(env, { body: { backup } }));
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.summary.books.incoming, 1);
  assert.equal(data.summary.books.current, 0);
  assert.equal(data.summary.chunks.incoming, 2);
  assert.equal(data.summary.chunks.current, 0);
});

test('replace 模式覆盖当前库，merge 模式只补齐不删除', async () => {
  const env = makeEnv();
  const backup = await exportTables(env);
  env.DB.exec(
    `DELETE FROM books;
     INSERT INTO books (id, upload_id, title, author, description, cover, format, isbn, publisher, language,
                        file_name, file_size, sha256, created_by, created_at, updated_at)
     VALUES ('extra', NULL, '多余的书', '', '', '', 'epub', '', '', '', '', 0, '', 'admin', 2, 2);`
  );

  const merged = await (await restoreBackup(ctx(env, { body: { backup, mode: 'merge' } }))).json();
  assert.equal(merged.mode, 'merge');
  const titles = (await env.DB.prepare('SELECT title FROM books ORDER BY title').all()).results.map((r) => r.title);
  assert.deepEqual(titles, ['书一', '多余的书'], 'merge 不应删除现有数据');

  await restoreBackup(ctx(env, { body: { backup, mode: 'replace' } }));
  const after = (await env.DB.prepare('SELECT title FROM books ORDER BY title').all()).results.map((r) => r.title);
  assert.deepEqual(after, ['书一'], 'replace 应只保留备份中的数据');
  const chunks = await env.DB.prepare('SELECT COUNT(*) AS n FROM chunks').first();
  assert.equal(chunks.n, 2);
});

test('加密备份可以直接用于预览与恢复', async () => {
  const env = makeEnv();
  const envelope = await encryptBackup(await exportTables(env), env.BACKUP_KEY);
  env.DB.exec('DELETE FROM books;');

  const preview = await (await previewBackup(ctx(env, { body: { backup: envelope } }))).json();
  assert.equal(preview.encrypted, true);
  assert.equal(preview.summary.books.incoming, 1);

  await restoreBackup(ctx(env, { body: { backup: envelope } }));
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM books').first();
  assert.equal(count.n, 1);
});

test('恢复与导出都不会访问 Telegram', async () => {
  const env = makeEnv();
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('备份流程不允许访问外部接口');
  };
  try {
    const backup = await exportTables(env);
    env.DB.exec('DELETE FROM books; DELETE FROM chunks;');
    await restoreBackup(ctx(env, { body: { backup, mode: 'replace' } }));
    const chunks = await env.DB.prepare('SELECT tg_file_id FROM chunks ORDER BY idx').all();
    assert.deepEqual(chunks.results.map((row) => row.tg_file_id), ['FILE0', 'FILE1']);
  } finally {
    globalThis.fetch = original;
  }
});

test('非管理员不能导出或恢复备份', async () => {
  const env = makeEnv();
  const member = { id: 'u2', username: 'member', role: 'member' };
  const deniedExport = await exportBackup({
    ...ctx(env, { method: 'GET', url: 'https://example.com/api/backup/export' }),
    data: { user: member },
  });
  assert.equal(deniedExport.status, 403);
  const deniedRestore = await restoreBackup({
    ...ctx(env, { body: { backup: { format: 'cf-book-backup', version: 1, tables: {} } } }),
    data: { user: member },
  });
  assert.equal(deniedRestore.status, 403);
});
