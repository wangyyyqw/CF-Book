import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet, onRequestPost, onRequestPut, onRequestDelete } from '../functions/api/tags/admin.js';
import { onRequestPost as mergePost } from '../functions/api/tags/admin/merge.js';
import { onRequestPost as importPost } from '../functions/api/tags/admin/import.js';
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

function context(env, user, { method = 'GET', body, query = '' } = {}) {
  return {
    env,
    request: new Request(`https://example.com/api/tags/admin${query}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }),
    data: { user },
  };
}

async function library(env, user = ADMIN) {
  return (await onRequestGet(context(env, user))).json();
}

test('标签库列表带使用数量与别名，并暴露从未使用的标签', async () => {
  const env = makeEnv();
  env.DB.exec(`INSERT INTO book_standard_tags (book_id, tag_id) VALUES ('b1', 'PUB_FIELD_0045');`);

  const data = await library(env);
  assert.equal(data.ok, true);
  assert.equal(data.tags.length, 878, '包含全部标签，含从未使用的');
  const used = data.tags.find((tag) => tag.tag_id === 'PUB_FIELD_0045');
  assert.equal(used.usage_count, 1);
  assert.ok(Array.isArray(used.aliases));
  assert.ok(data.tags.some((tag) => tag.usage_count === 0), '存在从未使用的标签');
});

test('非管理员不能访问标签库管理接口', async () => {
  const env = makeEnv();
  const res = await onRequestGet(context(env, MEMBER));
  assert.equal(res.status, 403);
  const write = await onRequestPost(context(env, MEMBER, { method: 'POST', body: { name: '新标签', dimension: 'pub_field' } }));
  assert.equal(write.status, 403);
});

test('新建标签按维度生成递增 ID，同维度重名被拒，跨维度可同名', async () => {
  const env = makeEnv();
  const first = await (await onRequestPost(context(env, ADMIN, {
    method: 'POST',
    body: { name: '测试题材甲', dimension: 'pub_topic', category: '题材', aliases: '甲, 甲A\n甲' },
  }))).json();
  assert.equal(first.ok, true);
  assert.match(first.tag.tag_id, /^PUB_TOPIC_\d{4}$/);

  const second = await (await onRequestPost(context(env, ADMIN, {
    method: 'POST',
    body: { name: '测试题材乙', dimension: 'pub_topic' },
  }))).json();
  assert.ok(second.tag.tag_id > first.tag.tag_id, '同维度 ID 递增');

  const dup = await onRequestPost(context(env, ADMIN, {
    method: 'POST',
    body: { name: '测试题材甲', dimension: 'pub_topic' },
  }));
  assert.equal(dup.status, 400);

  const crossDimension = await onRequestPost(context(env, ADMIN, {
    method: 'POST',
    body: { name: '测试题材甲', dimension: 'web_genre' },
  }));
  assert.equal(crossDimension.status, 200, '不同维度允许同名');

  const badDimension = await onRequestPost(context(env, ADMIN, {
    method: 'POST',
    body: { name: '无维度标签', dimension: 'not_a_dimension' },
  }));
  assert.equal(badDimension.status, 400);

  const stored = await library(env);
  const aliases = stored.tags.find((tag) => tag.tag_id === first.tag.tag_id).aliases;
  assert.deepEqual(aliases, ['甲', '甲A'], '别名去空去重');
});

test('编辑标签可改名、停用并替换别名，重名被拒', async () => {
  const env = makeEnv();
  const created = await (await onRequestPost(context(env, ADMIN, {
    method: 'POST',
    body: { name: '旧名字', dimension: 'pub_field' },
  }))).json();
  const tagId = created.tag.tag_id;

  const updated = await (await onRequestPut(context(env, ADMIN, {
    method: 'PUT',
    body: { tagId, name: '新名字', status: 'disabled', aliases: ['旧名字'] },
  }))).json();
  assert.equal(updated.tag.name, '新名字');
  assert.equal(updated.tag.status, 'disabled');

  const listed = await library(env);
  const tag = listed.tags.find((item) => item.tag_id === tagId);
  assert.deepEqual(tag.aliases, ['旧名字']);
  assert.equal(tag.status, 'disabled');

  const clash = await onRequestPut(context(env, ADMIN, {
    method: 'PUT',
    body: { tagId, name: '历史学' },
  }));
  assert.equal(clash.status, 400, '不能改成同维度已存在的名称');
});

test('删除标签会清掉书籍关联与别名', async () => {
  const env = makeEnv();
  const created = await (await onRequestPost(context(env, ADMIN, {
    method: 'POST',
    body: { name: '待删除', dimension: 'pub_field', aliases: '别名一' },
  }))).json();
  const tagId = created.tag.tag_id;
  env.DB.exec(`INSERT INTO book_standard_tags (book_id, tag_id) VALUES ('b1', '${tagId}');`);

  const res = await (await onRequestDelete(context(env, ADMIN, {
    method: 'DELETE',
    query: `?tag_id=${tagId}`,
  }))).json();
  assert.equal(res.ok, true);
  assert.equal(res.removed_links, 1);

  const tag = await env.DB.prepare('SELECT COUNT(*) AS n FROM standard_tags WHERE tag_id = ?').bind(tagId).first();
  assert.equal(Number(tag.n), 0);
  const links = await env.DB.prepare('SELECT COUNT(*) AS n FROM book_standard_tags WHERE tag_id = ?').bind(tagId).first();
  assert.equal(Number(links.n), 0);
  const aliases = await env.DB.prepare('SELECT COUNT(*) AS n FROM standard_tag_aliases WHERE tag_id = ?').bind(tagId).first();
  assert.equal(Number(aliases.n), 0);
});

test('合并标签把书、别名和子标签转到目标，并删除源标签', async () => {
  const env = makeEnv();
  const source = await (await onRequestPost(context(env, ADMIN, {
    method: 'POST',
    body: { name: '重复项', dimension: 'pub_topic', aliases: '重复别名' },
  }))).json();
  const target = await (await onRequestPost(context(env, ADMIN, {
    method: 'POST',
    body: { name: '保留项', dimension: 'pub_topic' },
  }))).json();
  const child = await (await onRequestPost(context(env, ADMIN, {
    method: 'POST',
    body: { name: '子标签', dimension: 'pub_topic', parent_id: source.tag.tag_id },
  }))).json();

  env.DB.exec(`INSERT INTO book_standard_tags (book_id, tag_id) VALUES ('b1', '${source.tag.tag_id}');`);

  const merged = await (await mergePost(context(env, ADMIN, {
    method: 'POST',
    body: { from: source.tag.tag_id, to: target.tag.tag_id },
  }))).json();
  assert.equal(merged.ok, true);
  assert.equal(merged.merged_books, 1);

  const listed = await library(env);
  assert.ok(!listed.tags.some((tag) => tag.tag_id === source.tag.tag_id), '源标签已删除');
  const targetTag = listed.tags.find((tag) => tag.tag_id === target.tag.tag_id);
  assert.equal(targetTag.usage_count, 1, '书籍关联已转移');
  assert.ok(targetTag.aliases.includes('重复别名'), '别名已转移');
  assert.ok(targetTag.aliases.includes('重复项'), '源标签名留作别名');
  assert.equal(listed.tags.find((tag) => tag.tag_id === child.tag.tag_id).parent_id, target.tag.tag_id);

  const crossDimension = await (await onRequestPost(context(env, ADMIN, {
    method: 'POST',
    body: { name: '跨维度目标', dimension: 'pub_field' },
  }))).json();
  const denied = await mergePost(context(env, ADMIN, {
    method: 'POST',
    body: { from: target.tag.tag_id, to: crossDimension.tag.tag_id },
  }));
  assert.equal(denied.status, 400);
});

test('导入 JSON 按名称或 ID 更新已有标签，其余新建', async () => {
  const env = makeEnv();
  const res = await (await importPost(context(env, ADMIN, {
    method: 'POST',
    body: {
      tags: [
        { tag_id: 'PUB_FIELD_0045', name: '历史学（导入改名）', aliases: ['历史学'] },
        { name: '导入新建标签', dimension: 'pub_topic', category: '题材' },
        { name: '', dimension: 'pub_topic' },
      ],
    },
  }))).json();
  assert.equal(res.ok, true);
  assert.equal(res.updated, 1);
  assert.equal(res.created, 1);
  assert.equal(res.skipped.length, 1);

  const listed = await library(env);
  assert.equal(listed.tags.find((tag) => tag.tag_id === 'PUB_FIELD_0045').name, '历史学（导入改名）');
  assert.ok(listed.tags.some((tag) => tag.name === '导入新建标签'));
});
