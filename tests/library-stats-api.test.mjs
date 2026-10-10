import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet } from '../functions/api/library/stats.js';
import { createD1, seedUser } from './helpers/d1.mjs';

function addBook(db, { id, title = '书', format = 'epub', language = '', fileSize = 0 }) {
  db.exec(
    `INSERT INTO books
       (id, upload_id, title, author, description, cover, format, isbn, publisher, language,
        file_name, file_size, sha256, created_by, created_at, updated_at)
     VALUES ('${id}', NULL, '${title}', '', '', '', '${format}', '', '', '${language}',
        '', ${fileSize}, '', 'admin', 0, 0)`
  );
}

function ctx(env, { role = 'admin' } = {}) {
  return {
    env,
    request: new Request('https://example.com/api/library/stats'),
    data: { user: { id: 'u1', username: 'admin', role } },
  };
}

function makeEnv() {
  const DB = createD1();
  seedUser(DB, { id: 'u1', username: 'admin', role: 'admin' });
  return { DB };
}

test('统计按格式与语言给出数量与占用大小', async () => {
  const env = makeEnv();
  addBook(env.DB, { id: 'b1', format: 'epub', language: 'zh', fileSize: 100 });
  addBook(env.DB, { id: 'b2', format: 'epub', language: 'zh', fileSize: 200 });
  addBook(env.DB, { id: 'b3', format: 'pdf', language: 'en', fileSize: 50 });
  addBook(env.DB, { id: 'b4', format: '', language: '', fileSize: 10 });

  const data = await (await onRequestGet(ctx(env))).json();
  assert.equal(data.ok, true);
  assert.equal(data.totals.books, 4);
  assert.equal(data.totals.size, 360);

  const epub = data.formats.find((row) => row.name === 'epub');
  assert.equal(epub.count, 2);
  assert.equal(epub.size, 300);
  assert.ok(data.formats.some((row) => row.name === '' && row.count === 1), '空格式单独成组，由前端标记未知');

  const zh = data.languages.find((row) => row.name === 'zh');
  assert.equal(zh.count, 2);
  assert.equal(zh.size, 300);
});

test('统计按标准标签给出数量与占用大小', async () => {
  const env = makeEnv();
  addBook(env.DB, { id: 'b1', fileSize: 100 });
  addBook(env.DB, { id: 'b2', fileSize: 200 });
  env.DB.exec(`INSERT INTO book_standard_tags (book_id, tag_id) VALUES
    ('b1', 'BOOK_TYPE_0001'), ('b1', 'PUB_FIELD_0045'),
    ('b2', 'BOOK_TYPE_0001');`);

  const data = await (await onRequestGet(ctx(env))).json();
  const type = data.tags.find((row) => row.tag_id === 'BOOK_TYPE_0001');
  assert.equal(type.count, 2);
  assert.equal(type.size, 300);
  assert.equal(type.dimension, 'book_type');
  const field = data.tags.find((row) => row.tag_id === 'PUB_FIELD_0045');
  assert.equal(field.count, 1);
  assert.equal(field.size, 100);
  assert.equal(data.tags.filter((row) => row.count === 0).length, 0, '未使用的标签不出现在统计里');
});

test('空库返回零值而不报错', async () => {
  const env = makeEnv();
  const data = await (await onRequestGet(ctx(env))).json();
  assert.equal(data.totals.books, 0);
  assert.equal(data.totals.size, 0);
  assert.deepEqual(data.formats, []);
  assert.deepEqual(data.tags, []);
});

test('非管理员不能查看书库统计', async () => {
  const env = makeEnv();
  const res = await onRequestGet(ctx(env, { role: 'member' }));
  assert.equal(res.status, 403);
});
