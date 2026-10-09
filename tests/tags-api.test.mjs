import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet } from '../functions/api/tags.js';
import { createD1 } from './helpers/d1.mjs';

test('标签接口只返回有书使用的标签，并返回无标签书籍数量', async () => {
  const env = { DB: createD1() };
  env.DB.exec(`
    INSERT INTO books (id, title, created_by, created_at, updated_at)
    VALUES ('b1', '已分类', 'admin', 1, 1), ('b2', '待整理', 'admin', 2, 2);
    INSERT INTO book_standard_tags (book_id, tag_id) VALUES ('b1', 'PUB_FIELD_0045');
  `);
  const data = await (await onRequestGet({ env })).json();
  assert.equal(data.ok, true);
  assert.equal(data.untaggedCount, 1);
  const usedTags = data.dimensions.flatMap((dimension) => dimension.tags);
  assert.deepEqual(usedTags.map((tag) => tag.tag_id), ['PUB_FIELD_0045']);
  assert.ok(usedTags.every((tag) => tag.count > 0));

  const all = await (await onRequestGet({
    env,
    request: new Request('https://example.com/api/tags?include_unused=1'),
  })).json();
  assert.ok(all.dimensions.flatMap((dimension) => dimension.tags).some((tag) => tag.count === 0));
});
