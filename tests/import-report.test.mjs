import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildImportReport, isMetadataIncomplete, matchesFilter } from '../public/import-report.js';

const book = (overrides) => ({
  status: 'completed',
  hasCover: true,
  meta: { author: '金庸', description: '武侠小说' },
  ...overrides,
});

test('导入报告按状态与元数据完整度分类统计', () => {
  const tasks = [
    book(),
    book(),
    book({ status: 'failed' }),
    book({ hasCover: false }),
    book({ hasCover: false }),
    book({ meta: { author: '', description: '有简介' } }),
    book({ meta: { author: '作者', description: '' } }),
  ];

  assert.deepEqual(buildImportReport(tasks), {
    total: 7,
    completed: 6,
    failed: 1,
    missingCover: 2,
    incompleteMeta: 2,
  });
});

test('缺少作者或简介都算元数据不完整，未完成的任务不计入', () => {
  assert.equal(isMetadataIncomplete(null), true);
  assert.equal(isMetadataIncomplete({ author: '  ', description: '有简介' }), true);
  assert.equal(isMetadataIncomplete({ author: '作者', description: ' ' }), true);
  assert.equal(isMetadataIncomplete({ author: '作者', description: '简介' }), false);

  const failedWithoutMeta = { status: 'failed', hasCover: false, meta: null };
  assert.equal(matchesFilter(failedWithoutMeta, 'incomplete-meta'), false);
  assert.equal(matchesFilter(failedWithoutMeta, 'failed'), true);
});

test('筛选按钮只保留对应类别的任务', () => {
  const tasks = [
    book({ id: 'ok' }),
    book({ id: 'nofile', status: 'failed' }),
    book({ id: 'nocover', hasCover: false }),
  ];
  assert.deepEqual(tasks.filter((task) => matchesFilter(task, '')).map((task) => task.id), ['ok', 'nofile', 'nocover']);
  assert.deepEqual(tasks.filter((task) => matchesFilter(task, 'completed')).map((task) => task.id), ['ok', 'nocover']);
  assert.deepEqual(tasks.filter((task) => matchesFilter(task, 'failed')).map((task) => task.id), ['nofile']);
  assert.deepEqual(tasks.filter((task) => matchesFilter(task, 'missing-cover')).map((task) => task.id), ['nocover']);
});
