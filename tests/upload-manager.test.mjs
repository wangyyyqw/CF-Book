import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUploadCenter } from '../public/upload-manager.js';
import { createUploadStore, createMemoryBackend as memoryBackend } from '../public/upload-store.js';
import { readJsonResponse, responseError } from '../public/upload-http.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function fakeFile(name = 'book.epub', size = 25) {
  const bytes = new Uint8Array(size);
  return {
    name,
    size,
    type: 'application/epub+zip',
    async arrayBuffer() {
      return bytes.buffer;
    },
    slice(start, end) {
      return new Blob([bytes.subarray(start, end)]);
    },
  };
}

// 模拟服务端：记录每本书已上传的分块，便于验证断点续传只重发失败分块。
function makeApi({ chunkSize = 10, preUploaded = [], failChunks = new Set(), holdChunk = null } = {}) {
  const uploaded = new Set(preUploaded);
  const calls = { init: 0, chunks: [], complete: 0, verify: 0, abort: 0 };
  let holdUsed = false;
  const api = async (url, options = {}) => {
    if (url === '/api/upload/init') {
      calls.init += 1;
      const total = Math.ceil(JSON.parse(options.body).size / chunkSize);
      return json({
        ok: true,
        uploadId: 'up1',
        chunkSize,
        totalChunks: total,
        resumed: uploaded.size > 0,
        uploadedChunks: [...uploaded],
      });
    }
    if (url === '/api/upload/chunk') {
      const index = Number(options.body.get('index'));
      calls.chunks.push(index);
      // 只卡住第一次请求，续传时同一分块要能正常完成
      if (index === holdChunk && !holdUsed) {
        holdUsed = true;
        return new Promise((_, reject) => {
          options.signal?.addEventListener('abort', () => reject(new DOMException('已中止', 'AbortError')));
        });
      }
      if (failChunks.has(index)) return json({ ok: false, error: '模拟分块失败' }, 500);
      uploaded.add(index);
      return json({ ok: true, index });
    }
    if (url === '/api/upload/complete') {
      calls.complete += 1;
      return json({ ok: true, bookId: 'book1' });
    }
    if (url === '/api/upload/abort') {
      calls.abort += 1;
      return json({ ok: true });
    }
    if (String(url).endsWith('/verify')) {
      calls.verify += 1;
      return json({ ok: true, verified: { total: 3, ok: 3, bad: 0, badChunks: [] } });
    }
    throw new Error(`未预期的请求：${url}`);
  };
  return { api, calls, uploaded };
}

function makeCenter(overrides = {}) {
  const backend = memoryBackend();
  const store = createUploadStore(backend);
  const server = overrides.server || makeApi(overrides.api || {});
  const center = createUploadCenter({
    store,
    api: server.api,
    readJsonResponse,
    responseError,
    hashFile: async () => 'a'.repeat(64),
    wait: async () => {},
    chunkRetries: 1,
    concurrency: 2,
    ...overrides.options,
  });
  return { center, store, backend, server };
}

test('上传成功后自动校验 Telegram 分块并记录结果', async () => {
  const { center, server } = makeCenter();
  await center.addFiles([fakeFile()]);
  center.start(center.list()[0].id);
  await center.whenIdle();

  const task = center.list()[0];
  assert.equal(task.status, 'completed');
  assert.deepEqual(task.failedChunks, []);
  assert.equal(task.bookId, 'book1');
  assert.equal(task.uploadedBytes, 25);
  assert.equal(server.calls.complete, 1);
  assert.equal(server.calls.verify, 1);
  assert.equal(task.verify.checked, true);
});

test('分块失败不中断整本书，重试时只补发失败的分块', async () => {
  const failChunks = new Set([1]);
  const { center, server } = makeCenter({ api: { failChunks } });
  await center.addFiles([fakeFile()]);
  const id = center.list()[0].id;
  center.start(id);
  await center.whenIdle();

  const failed = center.get(id);
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.failedChunks, [1]);
  assert.equal(server.calls.complete, 0, '还有失败分块时不应提交入库');
  assert.deepEqual(server.calls.chunks, [0, 1, 2]);

  failChunks.delete(1);
  center.start(id);
  await center.whenIdle();

  assert.equal(center.get(id).status, 'completed');
  assert.deepEqual(server.calls.chunks, [0, 1, 2, 1], '只应重新上传失败的第 2 块');
});

test('暂停会中止当前上传并保留已完成分块', async () => {
  const { center, server } = makeCenter({ api: { holdChunk: 1 } });
  await center.addFiles([fakeFile()]);
  const id = center.list()[0].id;
  center.start(id);
  await new Promise((resolve) => setTimeout(resolve, 0));

  center.pause(id);
  await center.whenIdle();
  const task = center.get(id);
  assert.equal(task.status, 'paused');
  assert.equal(task.speed, 0);
  assert.equal(server.calls.complete, 0);

  center.start(id);
  await center.whenIdle();
  assert.equal(center.get(id).status, 'completed');
  assert.equal(server.calls.init, 2, '继续上传会重新初始化并复用已完成分块');
});

test('取消单本会通知服务端中止并标记为已取消', async () => {
  const { center, server } = makeCenter({ api: { holdChunk: 1 } });
  await center.addFiles([fakeFile()]);
  const id = center.list()[0].id;
  center.start(id);
  await new Promise((resolve) => setTimeout(resolve, 0));

  await center.cancel(id);
  await center.whenIdle();
  assert.equal(center.get(id).status, 'cancelled');
  assert.equal(server.calls.abort, 1);
});

test('刷新页面后正在上传的任务变为已暂停，可手动继续', async () => {
  const backend = memoryBackend();
  const store = createUploadStore(backend);
  await store.saveTask({ id: 't1', status: 'uploading', createdAt: 1, filename: 'a.epub', failedChunks: [] });
  await store.saveTask({ id: 't2', status: 'completed', createdAt: 2, filename: 'b.epub', failedChunks: [] });

  const { api } = makeApi();
  const center = createUploadCenter({ store, api, readJsonResponse, responseError });
  await center.load();
  assert.deepEqual(center.list().map((task) => [task.id, task.status]), [['t1', 'paused'], ['t2', 'completed']]);
});

test('清理长期失效任务会调用服务端接口', async () => {
  const calls = [];
  const center = createUploadCenter({
    store: createUploadStore(memoryBackend()),
    api: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return json({ ok: true, deleted: 2, aborted: 1 });
    },
    readJsonResponse,
    responseError,
  });
  const result = await center.cleanupStaleTasks(7);
  assert.deepEqual(result, { ok: true, deleted: 2, aborted: 1 });
  assert.deepEqual(calls[0], { url: '/api/upload/cleanup', body: { days: 7 } });
});
