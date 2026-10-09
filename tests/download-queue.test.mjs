import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDownloadQueue } from '../public/download-queue.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test('下载队列按并发上限调度，完成后自动补位', async () => {
  const gates = [];
  const started = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const queue = createDownloadQueue({
    concurrency: 2,
    download: async (task) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      started.push(task.uploadId);
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
      inFlight -= 1;
    },
  });

  queue.add({ uploadId: 'a' });
  queue.add({ uploadId: 'b' });
  queue.add({ uploadId: 'c' });
  await tick();

  assert.deepEqual(started, ['a', 'b']);
  assert.equal(maxInFlight, 2);
  assert.equal(queue.activeCount(), 3);

  gates[0].resolve();
  await tick();
  assert.deepEqual(started, ['a', 'b', 'c']);

  gates[1].resolve();
  gates[2].resolve();
  await tick();
  assert.equal(queue.activeCount(), 0);
  assert.ok(queue.tasks().every((task) => task.status === 'done'));
});

test('暂停中止当前任务，继续后重新排队执行', async () => {
  let runs = 0;
  const queue = createDownloadQueue({
    download: (task, { signal }) => {
      runs += 1;
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('下载已中止', 'AbortError')));
      });
    },
  });

  const task = queue.add({ uploadId: 'a' });
  await tick();
  assert.equal(task.status, 'running');

  queue.pause(task.id);
  await tick();
  assert.equal(task.status, 'paused');
  assert.equal(task.speed, 0);

  queue.resume(task.id);
  await tick();
  assert.equal(task.status, 'running');
  assert.equal(runs, 2);
});

test('失败任务可以单独重试并记录历史', async () => {
  const history = [];
  let attempts = 0;
  const queue = createDownloadQueue({
    onHistory: (entry) => history.push(entry),
    download: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('网络中断');
    },
  });

  const task = queue.add({ uploadId: 'a', filename: 'a.epub' });
  await tick();
  assert.equal(task.status, 'failed');
  assert.equal(task.error, '网络中断');
  assert.equal(history.length, 1);
  assert.equal(history[0].status, 'failed');

  queue.retry(task.id);
  await tick();
  assert.equal(task.status, 'done');
  assert.equal(attempts, 2);
  assert.equal(history[1].status, 'done');
});

test('进度回调更新已下载大小、百分比与实时速度', async () => {
  let clock = 1000;
  const gate = deferred();
  const queue = createDownloadQueue({
    now: () => clock,
    download: async (task, { onProgress }) => {
      onProgress({ done: 1, total: 4, downloadedBytes: 1_000_000, totalBytes: 4_000_000 });
      clock += 1000;
      onProgress({ done: 2, total: 4, downloadedBytes: 2_000_000, totalBytes: 4_000_000 });
      await gate.promise;
    },
  });

  const task = queue.add({ uploadId: 'a', size: 4_000_000 });
  await tick();
  assert.equal(task.percent, 50);
  assert.equal(task.downloadedBytes, 2_000_000);
  assert.equal(Math.round(task.speed), 1_000_000);
  assert.equal(task.status, 'running');

  gate.resolve();
  await tick();
  assert.equal(task.status, 'done');
  assert.equal(task.percent, 100);
});

test('并发数可动态调整，清空已完成任务保留排队任务', async () => {
  const gates = [];
  const queue = createDownloadQueue({
    concurrency: 1,
    download: async () => {
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
    },
  });
  queue.add({ uploadId: 'a' });
  queue.add({ uploadId: 'b' });
  await tick();
  assert.equal(queue.activeCount(), 2);
  assert.equal(gates.length, 1);

  queue.setConcurrency(2);
  await tick();
  assert.equal(gates.length, 2);
  assert.equal(queue.hasActive(), true);

  gates[0].resolve();
  gates[1].resolve();
  await tick();
  assert.equal(queue.hasActive(), false);

  const done = queue.add({ uploadId: 'c' });
  done.status = 'done';
  queue.clearFinished();
  assert.equal(queue.tasks().length, 0);
});
