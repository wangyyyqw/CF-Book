import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runUploadQueue } from '../public/upload-queue.js';

test('批量上传按顺序执行，单本失败不阻塞后续文件', async () => {
  const events = [];
  const results = await runUploadQueue(['a', 'b', 'c'], async (file) => {
    events.push(`start:${file}`);
    if (file === 'b') throw new Error('模拟失败');
    return `${file}-ok`;
  }, {
    onStart: (file) => events.push(`queued:${file}`),
    onSuccess: (file) => events.push(`success:${file}`),
    onError: (file) => events.push(`error:${file}`),
  });

  assert.deepEqual(events, [
    'queued:a', 'start:a', 'success:a',
    'queued:b', 'start:b', 'error:b',
    'queued:c', 'start:c', 'success:c',
  ]);
  assert.deepEqual(results, [
    { file: 'a', status: 'completed', value: 'a-ok' },
    { file: 'b', status: 'failed', error: '模拟失败' },
    { file: 'c', status: 'completed', value: 'c-ok' },
  ]);
});

test('批量上传中止后不再启动后续文件', async () => {
  const controller = new AbortController();
  const started = [];
  const results = await runUploadQueue(['a', 'b', 'c'], async (file) => {
    started.push(file);
    if (file === 'a') controller.abort();
  }, { signal: controller.signal });

  assert.deepEqual(started, ['a']);
  assert.deepEqual(results, [
    { file: 'a', status: 'completed', value: undefined },
    { file: 'b', status: 'cancelled' },
    { file: 'c', status: 'cancelled' },
  ]);
});
