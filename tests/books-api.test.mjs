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

async function listResponse(env, query = '') {
  return onRequestGet(ctx(env, query));
}

async function list(env, query = '') {
  return (await listResponse(env, query)).json();
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

  const byTitle = await list(env, '?q=示例书籍A');
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
  env.DB.exec(`INSERT INTO book_standard_tags (book_id, tag_id) VALUES ('b1', 'PUB_FIELD_0045'), ('b2', 'PUB_FIELD_0049');`);

  const data = await list(env, '?tag=PUB_FIELD_0045');
  assert.deepEqual(data.books.map((b) => b.id), ['b1']);
  assert.equal(data.total, 1);
  assert.deepEqual(data.books[0].tags, '历史学');
  assert.deepEqual(data.books[0].tag_categories, { pub_field: ['历史学'] });
});

test('无标签筛选只返回没有标准标签的书', async () => {
  const env = makeEnv();
  addBook(env.DB, { id: 'b1', title: '已分类', created: 1 });
  addBook(env.DB, { id: 'b2', title: '待整理', created: 2 });
  env.DB.exec(`INSERT INTO book_standard_tags (book_id, tag_id) VALUES ('b1', 'PUB_FIELD_0045');`);

  const data = await list(env, '?tag=__untagged__');
  assert.deepEqual(data.books.map((b) => b.id), ['b2']);
  assert.equal(data.total, 1);
});

test('不合法标签 ID 不会先创建空标签书籍', async () => {
  const { onRequestPost } = await import('../functions/api/books/[id].js');
  const env = makeEnv();
  const response = await onRequestPost({
    env,
    request: new Request('https://example.com/api/books', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '不应写入', tagIds: ['BOOK_TYPE_0001', 'WEB_GENRE_0005', 'PUB_TOPIC_0088'] }),
    }),
    data: { user: { id: 'u1', username: 'admin', role: 'admin' } },
  });
  assert.equal(response.status, 400);
  const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM books').first();
  assert.equal(count.count, 0);
});

test('推荐接口按请求数量从全部书籍随机返回', async () => {
  const env = makeEnv();
  for (let i = 1; i <= 12; i++) addBook(env.DB, { id: `r${i}`, title: `推荐${i}`, created: i });
  env.DB.exec(
    `INSERT INTO book_user_state (book_id, user_id, rating, status, is_favorite, updated_at)
     VALUES ('r4', 'u1', 9.5, 'read', 0, 1), ('r2', 'u1', 8, 'read', 0, 1);`
  );

  const data = await list(env, '?recommended=1&limit=5');
  assert.equal(data.books.length, 5);
  assert.equal(data.total, 12, '总数反映整个馆藏');
  assert.equal(new Set(data.books.map((book) => book.id)).size, 5);
  assert.ok(data.books.every((book) => /^r(?:[1-9]|1[0-2])$/.test(book.id)));
});

test('紧凑书目列表批量读取标签，不按每本书重复查询', async () => {
  const env = makeEnv();
  for (let i = 1; i <= 5; i++) addBook(env.DB, { id: `b${i}`, title: `书${i}`, created: i });
  env.DB.exec(`INSERT INTO book_standard_tags (book_id, tag_id) VALUES
    ('b1', 'BOOK_TYPE_0001'), ('b1', 'PUB_FIELD_0045'), ('b1', 'PUB_TOPIC_0001'),
    ('b2', 'BOOK_TYPE_0001'), ('b2', 'PUB_FIELD_0049'), ('b2', 'PUB_TOPIC_0002');`);
  env.DB.resetQueryCount();

  const data = await list(env, '?compact=1&limit=5');
  assert.equal(env.DB.queryCount, 2, '应为书目和整页标签各 1 次查询');
  assert.equal(data.books[0].description, undefined, '紧凑响应不应携带详情页字段');
  const book = data.books.find((item) => item.id === 'b1');
  assert.equal(book.format, undefined, '紧凑响应不应携带详情页字段');
  assert.equal(book.my_rating, undefined, '卡片不需要当前账号评分');
  assert.deepEqual(book.tag_details, [{ name: '出版书' }, { name: '历史学' }, { name: '哲学思想' }]);
});

test('推荐请求显式跳过未使用的总数查询', async () => {
  const env = makeEnv();
  for (let i = 1; i <= 5; i++) addBook(env.DB, { id: `r${i}`, title: `推荐${i}`, created: i });
  env.DB.resetQueryCount();
  const data = await list(env, '?recommended=1&compact=1&count=0&limit=3');
  assert.equal(data.total, null);
  assert.equal(data.hasMore, false);
  assert.equal(env.DB.queryCount, 2, '推荐只需书目和整页标签查询');
});

test('随机推荐不使用浏览器缓存，普通书目允许短期缓存', async () => {
  const env = makeEnv();
  const recommended = await listResponse(env, '?recommended=1&compact=1&count=0&limit=1');
  const regular = await listResponse(env, '?compact=1&limit=1');
  assert.equal(recommended.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(regular.headers.get('Cache-Control'), 'private, max-age=5, stale-while-revalidate=15');
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
