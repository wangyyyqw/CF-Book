import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeFavorite,
  normalizeRating,
  normalizeStatus,
  parseTags,
  MAX_TAG_LENGTH,
} from '../functions/utils/books.js';

test('评分被限制在 0–10 并保留一位小数', () => {
  assert.equal(normalizeRating(8.46), 8.5);
  assert.equal(normalizeRating(8.44), 8.4);
  assert.equal(normalizeRating(0), 0);
  assert.equal(normalizeRating(10), 10);
  assert.equal(normalizeRating(99), 10);
  assert.equal(normalizeRating(-5), 0);
  assert.equal(normalizeRating('7.5'), 7.5);
});

test('非法评分回落到 0', () => {
  assert.equal(normalizeRating(undefined), 0);
  assert.equal(normalizeRating(null), 0);
  assert.equal(normalizeRating(''), 0);
  assert.equal(normalizeRating('abc'), 0);
  assert.equal(normalizeRating(NaN), 0);
  assert.equal(normalizeRating(Infinity), 0);
});

test('阅读状态只接受白名单内的值', () => {
  for (const s of ['unread', 'reading', 'read']) {
    assert.equal(normalizeStatus(s), s);
  }
  assert.equal(normalizeStatus('done'), 'unread');
  assert.equal(normalizeStatus(undefined), 'unread');
  assert.equal(normalizeStatus(null), 'unread');
});

test('收藏与阅读状态彼此独立', () => {
  assert.equal(normalizeFavorite(true), 1);
  assert.equal(normalizeFavorite(false), 0);
  assert.equal(normalizeFavorite('yes'), 0);
  assert.equal(normalizeFavorite(''), 0);
});

test('标签清洗：去空、去重、保序', () => {
  const result = parseTags(['  历史 ', '历史', '', '  ', '文言文']);
  assert.deepEqual(result.tags, ['历史', '文言文']);
});

test('非数组标签视为空', () => {
  assert.deepEqual(parseTags(undefined).tags, []);
  assert.deepEqual(parseTags('历史').tags, []);
  assert.deepEqual(parseTags(null).tags, []);
});

test('标签超长或不限量时返回错误而不是静默截断', () => {
  const tooLong = parseTags(['x'.repeat(MAX_TAG_LENGTH + 1)]);
  assert.ok(tooLong.error, '超长标签应报错');
  assert.equal(tooLong.tags, undefined);

  const tooMany = parseTags(Array.from({ length: 31 }, (_, i) => `t${i}`));
  assert.ok(tooMany.error, '超量标签应报错');

  const ok = parseTags(Array.from({ length: 30 }, (_, i) => `t${i}`));
  assert.equal(ok.error, undefined);
  assert.equal(ok.tags.length, 30);
});
