import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPut } from '../functions/api/books/[id]/state.js';
import { onRequestGet as getBook } from '../functions/api/books/[id].js';
import { createD1, seedUser } from './helpers/d1.mjs';

function makeEnv() {
  const DB = createD1();
  seedUser(DB, { id: 'u1', username: 'admin', displayName: '管理员', role: 'admin' });
  seedUser(DB, { id: 'u2', username: 'member', displayName: '成员', role: 'member' });
  DB.exec(
    `INSERT INTO books (id, upload_id, title, author, description, cover, format, isbn, publisher, language,
        file_name, file_size, sha256, created_by, created_at, updated_at)
     VALUES ('b1', NULL, '书一', '', '', '', 'epub', '', '', '', '', 0, '', 'admin', 0, 0)`
  );
  return { DB };
}

function putState(env, user, body) {
  return onRequestPut({
    env,
    params: { id: 'b1' },
    data: { user },
    request: new Request('https://example.com/api/books/b1/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  });
}

function readBook(env, user) {
  return getBook({
    env,
    params: { id: 'b1' },
    data: { user },
    request: new Request('https://example.com/api/books/b1'),
  });
}

const admin = { id: 'u1', username: 'admin', role: 'admin' };
const member = { id: 'u2', username: 'member', role: 'member' };

test('保存评论会写入并在详情接口回填 my_comment', async () => {
  const env = makeEnv();
  const res = await putState(env, admin, { rating: 8, status: 'read', comment: '  很有启发  ' });
  const saved = await res.json();
  assert.equal(saved.ok, true);
  assert.equal(saved.comment, '很有启发', '保存时应去除首尾空白');

  const book = (await (await readBook(env, admin)).json()).book;
  assert.equal(book.my_comment, '很有启发');
  assert.equal(book.my_rating, 8);
});

test('评论超过 500 字会被截断', async () => {
  const env = makeEnv();
  const long = 'x'.repeat(600);
  const saved = await (await putState(env, admin, { comment: long })).json();
  assert.equal(saved.comment.length, 500);
});

test('只传评论不会清空已有的评分与状态', async () => {
  const env = makeEnv();
  await putState(env, admin, { rating: 7, status: 'reading', isFavorite: true });
  await putState(env, admin, { comment: '补一条笔记' });

  const book = (await (await readBook(env, admin)).json()).book;
  assert.equal(book.my_rating, 7, '省略 rating 时保留原值');
  assert.equal(book.my_status, 'reading');
  assert.equal(book.my_favorite, true);
  assert.equal(book.my_comment, '补一条笔记');
});

test('各账号的评论互相隔离，详情接口能看到他人评论', async () => {
  const env = makeEnv();
  await putState(env, admin, { rating: 9, comment: '管理员的评论' });
  await putState(env, member, { rating: 6, comment: '成员的评论' });

  const asMember = (await (await readBook(env, member)).json()).book;
  assert.equal(asMember.my_comment, '成员的评论');
  const adminRow = asMember.ratings.find((r) => r.user_id === 'u1');
  assert.equal(adminRow.comment, '管理员的评论', '他人评论随 ratings 返回');
});

test('清空评论传空串会覆盖原值', async () => {
  const env = makeEnv();
  await putState(env, admin, { comment: '先写一条' });
  const saved = await (await putState(env, admin, { comment: '' })).json();
  assert.equal(saved.comment, '');

  const book = (await (await readBook(env, admin)).json()).book;
  assert.equal(book.my_comment, '');
});
