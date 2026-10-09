import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet } from '../functions/api/books.js';
import { createD1 } from './helpers/d1.mjs';

function addBook(db, { id, title, author = '', created, description = '' }) {
  db.exec(
    `INSERT INTO books
       (id, upload_id, title, author, description, cover, format, isbn, publisher, language,
        file_name, file_size, sha256, created_by, created_at, updated_at)
     VALUES ('${id}', NULL, '${title}', '${author}', '${description}', '', 'epub', '', '', '',
        '', 0, '', 'admin', ${created}, ${created})`
  );
}

function makeEnv() {
  const DB = createD1();
  DB.exec(
    `INSERT INTO users (id, username, display_name, password_hash, role, disabled, created_at, updated_at)
     VALUES ('u1', 'admin', '管理员', 'x', 'admin', 0, 0, 0), ('u2', 'member', '成员', 'x', 'member', 0, 0, 0)`
  );
  return { DB };
}

function ctx(env, query = '') {
  return {
    env,
    request: new Request(`https://example.com/api/books${query}`),
    data: { user: { id: 'u1', username: 'admin', role: 'admin' } },
  };
}

async function list(env, query = '') {
  return (await onRequestGet(ctx(env, query))).json();
}

test('默认返回全部书籍，并给出总数与是否还有下一页', async () => {
  const env = makeEnv();
  for (let i = 1; i <= 3; i++) addBook(env.DB, { id: `b${i}`, title: `书${i}`, created: i });

  const data = await list(env);
  assert.equal(data.ok, true);
  assert.equal(data.books.length, 3);
  assert.equal(data.total, 3);
  assert.equal(data.hasMore, false);
});

test('超过一页时不再静默截断，分页可取回全部', async () => {
  const env = makeEnv();
  for (let i = 1; i <= 130; i++) addBook(env.DB, { id: `b${i}`, title: `书${i}`, created: i });

  const first = await list(env);
  assert.equal(first.books.length, 18, '默认每页 18 本');
  assert.equal(first.total, 130, '总数必须是全部匹配数，而不是本页条数');
  assert.equal(first.hasMore, true);

  const pages = [first.books];
  let offset = 18;
  while (offset < 130) {
    const page = await list(env, `?offset=${offset}`);
    pages.push(page.books);
    offset += page.books.length;
    if (!page.hasMore) break;
  }

  const seen = new Set(pages.flat().map((b) => b.id));
  assert.equal(seen.size, 130, '两页之间不应重复或遗漏');
});

test('offset 分页按创建时间倒序且不重不漏', async () => {
  const env = makeEnv();
  for (let i = 1; i <= 5; i++) addBook(env.DB, { id: `b${i}`, title: `书${i}`, created: i });

  const page1 = await list(env, '?limit=2');
  const page2 = await list(env, '?limit=2&offset=2');
  const page3 = await list(env, '?limit=2&offset=4');

  assert.deepEqual(page1.books.map((b) => b.id), ['b5', 'b4']);
  assert.deepEqual(page2.books.map((b) => b.id), ['b3', 'b2']);
  assert.deepEqual(page3.books.map((b) => b.id), ['b1']);
  assert.equal(page1.total, 5);
  assert.equal(page1.hasMore, true);
  assert.equal(page3.hasMore, false);
});

test('搜索时总数跟随筛选条件', async () => {
  const env = makeEnv();
  addBook(env.DB, { id: 'b1', title: '资治通鉴', author: '司马光', created: 1 });
  addBook(env.DB, { id: 'b2', title: '示例书籍A', author: '示例作者', created: 2 });
  addBook(env.DB, { id: 'b3', title: '阿加莎全集', author: '阿加莎', created: 3 });

  const byTitle = await list(env, '?q=荒凉');
  assert.deepEqual(byTitle.books.map((b) => b.id), ['b2']);
  assert.equal(byTitle.total, 1);

  const byAuthor = await list(env, '?q=司马');
  assert.deepEqual(byAuthor.books.map((b) => b.id), ['b1']);
  assert.equal(byAuthor.total, 1);
});

test('按标签筛选，总数同样跟随筛选', async () => {
  const env = makeEnv();
  addBook(env.DB, { id: 'b1', title: '书1', created: 1 });
  addBook(env.DB, { id: 'b2', title: '书2', created: 2 });
  env.DB.exec(
    `INSERT INTO tags (id, name) VALUES (1, '历史'), (2, '小说');
     INSERT INTO book_tags (book_id, tag_id) VALUES ('b1', 1), ('b2', 2);`
  );

  const data = await list(env, '?tag=历史');
  assert.deepEqual(data.books.map((b) => b.id), ['b1']);
  assert.equal(data.total, 1);
  assert.deepEqual(data.books[0].tags, '历史');
  assert.deepEqual(data.books[0].tag_categories, { 学科: ['历史'] });
});

test('推荐接口最多返回九本，并按评分优先', async () => {
  const env = makeEnv();
  for (let i = 1; i <= 12; i++) addBook(env.DB, { id: `r${i}`, title: `推荐${i}`, created: i });
  env.DB.exec(
    `INSERT INTO book_user_state (book_id, user_id, rating, status, is_favorite, updated_at)
     VALUES ('r4', 'u1', 9.5, 'read', 0, 1), ('r2', 'u1', 8, 'read', 0, 1);`
  );

  const data = await list(env, '?recommended=1&limit=50');
  assert.equal(data.books.length, 9);
  assert.equal(data.total, 9, '推荐集合总数最多为九本');
  assert.equal(data.hasMore, false);
  assert.equal(data.books[0].id, 'r4');
  assert.equal(data.books[1].id, 'r2');
});

test('收藏与阅读状态按当前账号隔离，总数只看自己的状态', async () => {
  const env = makeEnv();
  addBook(env.DB, { id: 'b1', title: '书1', created: 1 });
  addBook(env.DB, { id: 'b2', title: '书2', created: 2 });
  env.DB.exec(
    `INSERT INTO book_user_state (book_id, user_id, rating, status, is_favorite, updated_at)
     VALUES ('b1', 'u1', 9, 'reading', 1, 1), ('b2', 'u2', 8, 'read', 1, 1)`
  );

  const favorites = await list(env, '?status=favorite');
  assert.deepEqual(favorites.books.map((b) => b.id), ['b1'], '只看自己的收藏');
  assert.equal(favorites.total, 1);

  const reading = await list(env, '?status=reading');
  assert.deepEqual(reading.books.map((b) => b.id), ['b1']);

  const all = await list(env);
  assert.equal(all.total, 2);
  assert.equal(all.books.find((b) => b.id === 'b1').my_rating, 9);
  assert.equal(all.books.find((b) => b.id === 'b1').rating_avg, 9);
  assert.equal(all.books.find((b) => b.id === 'b2').my_rating, 0, '别人的评分不算成我的');
});
