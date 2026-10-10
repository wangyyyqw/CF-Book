import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet, onRequestPost } from '../functions/api/shelves.js';
import { onRequestPut, onRequestDelete } from '../functions/api/shelves/[id].js';
import { onRequestPut as putBooks } from '../functions/api/shelves/[id]/books.js';
import { onRequestGet as getBooks } from '../functions/api/books.js';
import { createD1 } from './helpers/d1.mjs';

const ADMIN = { id: 'u1', username: 'admin', role: 'admin' };
const MEMBER = { id: 'u2', username: 'member', role: 'member' };

function makeEnv() {
  const DB = createD1();
  DB.exec(
    `INSERT INTO users (id, username, display_name, password_hash, role, disabled, created_at, updated_at)
     VALUES ('u1', 'admin', '管理员', 'x', 'admin', 0, 0, 0), ('u2', 'member', '成员', 'x', 'member', 0, 0, 0);
     INSERT INTO books (id, title, created_by, created_at, updated_at)
     VALUES ('b1', '书一', 'admin', 1, 1), ('b2', '书二', 'admin', 2, 2);`
  );
  return { DB };
}

function context(env, user, { method = 'GET', body, params } = {}) {
  return {
    env,
    params,
    request: new Request('https://example.com/api/shelves', {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }),
    data: { user },
  };
}

async function createShelf(env, user, body) {
  return (await onRequestPost(context(env, user, { method: 'POST', body }))).json();
}

async function listFor(env, user) {
  return (await onRequestGet(context(env, user))).json();
}

test('成员只能看到共享书架与自己的个人书架', async () => {
  const env = makeEnv();
  const shared = await createShelf(env, ADMIN, { name: '待读', scope: 'shared' });
  const mine = await createShelf(env, MEMBER, { name: '旅行阅读', scope: 'personal' });
  await createShelf(env, ADMIN, { name: '管理员的私人架', scope: 'personal' });

  const member = await listFor(env, MEMBER);
  assert.deepEqual(member.shelves.map((s) => s.id).sort(), [shared.shelf.id, mine.shelf.id].sort());
  assert.ok(member.shelves.every((s) => s.book_count === 0));

  const admin = await listFor(env, ADMIN);
  assert.equal(admin.shelves.length, 2, '管理员也看不到别人的个人书架');
  assert.ok(admin.shelves.some((s) => s.scope === 'shared'));
});

test('只有管理员能建共享书架，成员建共享书架被拒', async () => {
  const env = makeEnv();
  const denied = await onRequestPost(context(env, MEMBER, { method: 'POST', body: { name: '金庸作品', scope: 'shared' } }));
  assert.equal(denied.status, 403);

  const personal = await createShelf(env, MEMBER, { name: '漫画收藏', scope: 'personal' });
  assert.equal(personal.ok, true);
  assert.equal(personal.shelf.scope, 'personal');
  assert.equal(personal.shelf.owner, 'member');
});

test('同一归属下不允许重名，不同归属互不影响', async () => {
  const env = makeEnv();
  await createShelf(env, ADMIN, { name: '待补封面', scope: 'shared' });
  const dup = await onRequestPost(context(env, ADMIN, { method: 'POST', body: { name: '待补封面', scope: 'shared' } }));
  assert.equal(dup.status, 400);

  const personal = await createShelf(env, ADMIN, { name: '待补封面', scope: 'personal' });
  assert.equal(personal.ok, true, '共享与个人书架可以同名');
});

test('空名称与超长名称被规范化处理', async () => {
  const env = makeEnv();
  const empty = await onRequestPost(context(env, ADMIN, { method: 'POST', body: { name: '   ' } }));
  assert.equal(empty.status, 400);

  const long = await createShelf(env, ADMIN, { name: '书'.repeat(40), scope: 'personal' });
  assert.equal(long.shelf.name.length, 24);
});

test('个人书架只有本人能改名与删除，共享书架只有管理员能动', async () => {
  const env = makeEnv();
  const shared = await createShelf(env, ADMIN, { name: '家庭成员推荐', scope: 'shared' });
  const mine = await createShelf(env, MEMBER, { name: '最近上传', scope: 'personal' });

  const memberRenamesShared = await onRequestPut(
    context(env, MEMBER, { method: 'PUT', body: { name: '改名' }, params: { id: shared.shelf.id } })
  );
  assert.equal(memberRenamesShared.status, 403);

  const otherRenamesMine = await onRequestPut(
    context(env, ADMIN, { method: 'PUT', body: { name: '改名' }, params: { id: mine.shelf.id } })
  );
  assert.equal(otherRenamesMine.status, 403, '别人的个人书架，管理员也不能改名');

  const ownerRenames = await onRequestPut(
    context(env, MEMBER, { method: 'PUT', body: { name: '最近下载' }, params: { id: mine.shelf.id } })
  );
  assert.equal(ownerRenames.status, 200);
  assert.equal((await ownerRenames.json()).shelf.name, '最近下载');

  const memberDeletesShared = await onRequestDelete(
    context(env, MEMBER, { method: 'DELETE', params: { id: shared.shelf.id } })
  );
  assert.equal(memberDeletesShared.status, 403);

  const adminDeletesShared = await onRequestDelete(
    context(env, ADMIN, { method: 'DELETE', params: { id: shared.shelf.id } })
  );
  assert.equal(adminDeletesShared.status, 200);
});

test('批量增删只处理存在的书，忽略重复添加并返回最新数量', async () => {
  const env = makeEnv();
  const shelf = (await createShelf(env, ADMIN, { name: '待读', scope: 'shared' })).shelf;

  const first = await putBooks(
    context(env, MEMBER, { method: 'PUT', body: { add: ['b1', 'b2', 'b1', 'missing'] }, params: { id: shelf.id } })
  );
  const firstData = await first.json();
  assert.equal(firstData.added, 2, '重复与不存在的书不计入新增');
  assert.equal(firstData.book_count, 2);

  const second = await putBooks(
    context(env, MEMBER, { method: 'PUT', body: { add: ['b1'], remove: ['b2'] }, params: { id: shelf.id } })
  );
  const secondData = await second.json();
  assert.equal(secondData.added, 0, '已在书架里的书不会重复计入');
  assert.equal(secondData.removed, 1);
  assert.equal(secondData.book_count, 1);
});

test('删除书架只移除成员关系，不动书籍本身', async () => {
  const env = makeEnv();
  const shelf = (await createShelf(env, ADMIN, { name: '待读', scope: 'shared' })).shelf;
  await putBooks(context(env, ADMIN, { method: 'PUT', body: { add: ['b1', 'b2'] }, params: { id: shelf.id } }));

  const res = await onRequestDelete(context(env, ADMIN, { method: 'DELETE', params: { id: shelf.id } }));
  assert.equal(res.status, 200);

  const books = await env.DB.prepare('SELECT COUNT(*) AS n FROM books').first();
  assert.equal(Number(books.n), 2);
  const links = await env.DB.prepare('SELECT COUNT(*) AS n FROM shelf_books').first();
  assert.equal(Number(links.n), 0);
});

test('书库接口按书架筛选，不可见的个人书架返回 404', async () => {
  const env = makeEnv();
  const shared = (await createShelf(env, ADMIN, { name: '待读', scope: 'shared' })).shelf;
  const adminPersonal = (await createShelf(env, ADMIN, { name: '金庸作品', scope: 'personal' })).shelf;
  await putBooks(context(env, ADMIN, { method: 'PUT', body: { add: ['b1'] }, params: { id: shared.id } }));
  await putBooks(context(env, ADMIN, { method: 'PUT', body: { add: ['b2'] }, params: { id: adminPersonal.id } }));

  const memberShared = await (await getBooks({
    env,
    request: new Request(`https://example.com/api/books?shelf=${shared.id}`),
    data: { user: MEMBER },
  })).json();
  assert.deepEqual(memberShared.books.map((b) => b.id), ['b1']);
  assert.equal(memberShared.total, 1);

  const memberHidden = await getBooks({
    env,
    request: new Request(`https://example.com/api/books?shelf=${adminPersonal.id}`),
    data: { user: MEMBER },
  });
  assert.equal(memberHidden.status, 404);

  const adminOwn = await (await getBooks({
    env,
    request: new Request(`https://example.com/api/books?shelf=${adminPersonal.id}`),
    data: { user: ADMIN },
  })).json();
  assert.deepEqual(adminOwn.books.map((b) => b.id), ['b2']);
});

test('书籍详情返回当前账号可见的书架归属', async () => {
  const { onRequestGet: getBook } = await import('../functions/api/books/[id].js');
  const env = makeEnv();
  const shared = (await createShelf(env, ADMIN, { name: '待读', scope: 'shared' })).shelf;
  const adminPersonal = (await createShelf(env, ADMIN, { name: '金庸作品', scope: 'personal' })).shelf;
  await putBooks(context(env, ADMIN, { method: 'PUT', body: { add: ['b1'] }, params: { id: shared.id } }));
  await putBooks(context(env, ADMIN, { method: 'PUT', body: { add: ['b1'] }, params: { id: adminPersonal.id } }));

  const member = await (await getBook({
    env,
    params: { id: 'b1' },
    data: { user: MEMBER },
  })).json();
  assert.deepEqual(member.book.shelf_ids, [shared.id], '别人的个人书架不返回给成员');

  const admin = await (await getBook({ env, params: { id: 'b1' }, data: { user: ADMIN } })).json();
  assert.equal(admin.book.shelf_ids.length, 2);
});
