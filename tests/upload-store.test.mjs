import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUploadStore, createMemoryBackend } from '../public/upload-store.js';

const memoryBackend = createMemoryBackend;

test('任务与本地文件分开保存，可以按 id 取回', async () => {
  const store = createUploadStore(memoryBackend());
  await store.saveTask({ id: 'a', filename: 'a.epub', status: 'pending' });
  await store.saveFile('a', { name: 'a.epub' });

  assert.equal((await store.loadTask('a')).filename, 'a.epub');
  assert.equal((await store.loadTasks()).length, 1);
  assert.deepEqual(await store.loadFile('a'), { name: 'a.epub' });
});

test('删除任务会同时清掉本地文件副本', async () => {
  const backend = memoryBackend();
  const store = createUploadStore(backend);
  await store.saveTask({ id: 'a', status: 'pending' });
  await store.saveFile('a', { name: 'a.epub' });

  await store.remove('a');
  assert.equal(await store.loadTask('a'), null);
  assert.equal(await store.loadFile('a'), null);
});

test('清理只删除已结束的任务，未完成的任务保留文件副本', async () => {
  const backend = memoryBackend();
  const store = createUploadStore(backend);
  for (const [id, status] of [['done', 'completed'], ['gone', 'cancelled'], ['todo', 'pending'], ['paused', 'paused']]) {
    await store.saveTask({ id, status });
    await store.saveFile(id, { name: `${id}.epub` });
  }

  assert.equal(await store.clearFinished(), 2);
  assert.deepEqual((await store.loadTasks()).map((task) => task.id).sort(), ['paused', 'todo']);
  assert.equal(await store.loadFile('done'), null);
  assert.deepEqual(await store.loadFile('todo'), { name: 'todo.epub' });
});
