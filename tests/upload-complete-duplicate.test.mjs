import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost } from '../functions/api/upload/complete.js';
import { createD1 } from './helpers/d1.mjs';

function makeEnv() {
  const DB = createD1();
  DB.exec(`
    INSERT INTO users (id, username, display_name, password_hash, role, disabled, created_at, updated_at)
    VALUES ('u1', 'admin', '管理员', 'x', 'admin', 0, 0, 0);
    INSERT INTO uploads (upload_id, filename, mime, total_size, chunk_size, total_chunks, sha256, status, owner, created_at, updated_at)
    VALUES ('up1', 'book.epub', 'application/epub+zip', 25, 10, 3, 'HASH-A', 'active', 'admin', 1, 1);
    INSERT INTO chunks (upload_id, idx, size, status, updated_at) VALUES
      ('up1', 0, 10, 'uploaded', 1), ('up1', 1, 10, 'uploaded', 1), ('up1', 2, 5, 'uploaded', 1);
  `);
  return { DB };
}

function completeCtx(env, body) {
  return {
    env,
    request: new Request('https://example.test/api/upload/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    data: { user: { username: 'admin', role: 'admin' } },
  };
}

test('同内容哈希的书籍已存在时返回疑似重复提示但仍完成入库', async () => {
  const env = makeEnv();
  env.DB.exec(`INSERT INTO books (id, upload_id, title, author, description, cover, format, isbn, publisher, language,
    file_name, file_size, sha256, created_by, created_at, updated_at)
    VALUES ('b-old', 'up-old', '资治通鉴', '司马光', '', '', 'epub', '', '', '', 'old.epub', 25, 'HASH-A', 'admin', 1, 1);`);

  const response = await onRequestPost(completeCtx(env, { uploadId: 'up1', sha256: 'HASH-A', meta: { title: '资治通鉴（重复）' } }));
  const data = await response.json();
  assert.equal(data.ok, true);
  assert.equal(data.bookCreated, true);
  assert.equal(data.suspectedDuplicate, true, '应提示疑似重复');
  assert.equal(data.duplicateOf.id, 'b-old');
  assert.equal(data.duplicateOf.title, '资治通鉴');

  // 仍然建立了新书，不拦截上传
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM books').first();
  assert.equal(count.n, 2, '疑似重复不应拦截入库');
});

test('内容哈希无冲突时不提示重复', async () => {
  const env = makeEnv();
  const response = await onRequestPost(completeCtx(env, { uploadId: 'up1', sha256: 'HASH-A', meta: { title: '独一无二' } }));
  const data = await response.json();
  assert.equal(data.ok, true);
  assert.equal(data.suspectedDuplicate, false);
  assert.equal(data.duplicateOf, null);
});

test('重复检测排除自身的 upload_id，重复完成同一上传不误报', async () => {
  const env = makeEnv();
  // 第一次完成，建立 up1 对应的书
  await onRequestPost(completeCtx(env, { uploadId: 'up1', sha256: 'HASH-A', meta: { title: '只上传一次' } }));
  // 再次调用 complete：书已存在（按 upload_id 命中 existing 分支），不应把自己当重复
  const response = await onRequestPost(completeCtx(env, { uploadId: 'up1', sha256: 'HASH-A', meta: { title: '只上传一次' } }));
  const data = await response.json();
  assert.equal(data.ok, true);
  assert.equal(data.suspectedDuplicate, false, '同一上传重复完成不应自我误报');
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM books').first();
  assert.equal(count.n, 1);
});
