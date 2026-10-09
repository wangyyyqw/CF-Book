import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDownload, openDownloadSink, triggerBrowserSave } from '../public/download-stream.js';

function fakeSink(kind = 'test') {
  const writes = [];
  return {
    kind,
    writes,
    aborted: false,
    async write(chunk) {
      writes.push(chunk);
    },
    async close() {},
    async abort() {
      this.aborted = true;
    },
  };
}

function chunksOf(count, size = 10) {
  return Array.from({ length: count }, (_, index) => ({ index, size }));
}

test('分块严格按序号写入，并发不超过窗口上限', async () => {
  const sink = fakeSink();
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchChunk = async (chunk) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    // 前面的分块故意更慢，验证乱序返回时仍按序号落盘
    await new Promise((resolve) => setTimeout(resolve, (6 - chunk.index) * 2));
    inFlight -= 1;
    return new Uint8Array(chunk.size).fill(chunk.index);
  };

  const progress = [];
  const result = await runDownload({
    chunks: chunksOf(6),
    sink,
    fetchChunk,
    windowSize: 2,
    onProgress: (state) => progress.push(state.done),
  });

  assert.deepEqual(sink.writes.map((bytes) => bytes[0]), [0, 1, 2, 3, 4, 5]);
  assert.ok(maxInFlight <= 2, `并发 ${maxInFlight} 超过了窗口上限 2`);
  assert.equal(result.downloadedBytes, 60);
  assert.deepEqual(progress, [1, 2, 3, 4, 5, 6]);
});

test('空分块列表直接完成，不写入任何内容', async () => {
  const sink = fakeSink();
  const result = await runDownload({ chunks: [], sink, fetchChunk: async () => new Uint8Array() });
  assert.equal(result.total, 0);
  assert.equal(result.downloadedBytes, 0);
  assert.deepEqual(sink.writes, []);
});

test('中止信号会让下载抛出 AbortError，而不是写出半截文件', async () => {
  const controller = new AbortController();
  const sink = fakeSink();
  const fetchChunk = async (chunk) => {
    if (chunk.index === 1) controller.abort();
    return new Uint8Array(chunk.size);
  };

  await assert.rejects(
    () => runDownload({ chunks: chunksOf(4), sink, fetchChunk, signal: controller.signal }),
    (error) => error.name === 'AbortError'
  );
});

test('不支持文件系统访问 API 与 OPFS 时退回内存 Blob 合并', async () => {
  const saved = [];
  const env = {
    Blob: class {
      constructor(parts) {
        this.parts = parts;
      }
    },
    URL: { createObjectURL: (blob) => (saved.push(blob), 'blob:1'), revokeObjectURL: () => {} },
    document: { createElement: () => ({ style: {}, click() {}, remove() {} }), body: { appendChild: () => {} } },
    setTimeout: () => 0,
  };
  const sink = await openDownloadSink('book.epub', { env });
  assert.equal(sink.kind, 'blob');
  await sink.write(new Uint8Array(3));
  await sink.close();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].parts.length, 1);
});

test('用户点击下载时优先写入系统保存框指定的文件', async () => {
  const written = [];
  const env = {
    showSaveFilePicker: async () => ({
      createWritable: async () => ({
        write: async (chunk) => written.push(chunk),
        close: async () => written.push('closed'),
        abort: async () => {},
      }),
    }),
  };
  const sink = await openDownloadSink('book.epub', { preferFilePicker: true, env });
  assert.equal(sink.kind, 'file-system-access');
  await sink.write(new Uint8Array(4));
  await sink.close();
  assert.equal(written.length, 2);
});

test('用户在保存框点取消时不改存到其他位置', async () => {
  const abortError = new Error('用户取消');
  abortError.name = 'AbortError';
  const env = {
    showSaveFilePicker: async () => {
      throw abortError;
    },
    navigator: { storage: { getDirectory: async () => ({}) } },
    crypto: { randomUUID: () => 'uuid' },
  };
  await assert.rejects(
    () => openDownloadSink('book.epub', { preferFilePicker: true, env }),
    (error) => error.name === 'AbortError'
  );
});

test('没有文件系统访问 API 时写入 OPFS 并把磁盘文件交给浏览器', async () => {
  const stored = new Map();
  const root = {
    async getFileHandle(name) {
      return {
        kind: 'file',
        async createWritable() {
          const parts = [];
          return {
            write: async (chunk) => parts.push(chunk),
            close: async () => stored.set(name, parts),
            abort: async () => {},
          };
        },
        async getFile() {
          return { kind: 'file', size: 2, lastModified: Date.now() };
        },
      };
    },
    async removeEntry(name) {
      stored.delete(name);
    },
  };
  const saved = [];
  const env = {
    navigator: { storage: { getDirectory: async () => root } },
    crypto: { randomUUID: () => 'uuid-1' },
    URL: { createObjectURL: (blob) => (saved.push(blob), 'blob:1'), revokeObjectURL: () => {} },
    document: { createElement: () => ({ style: {}, click() {}, remove() {} }), body: { appendChild: () => {} } },
    setTimeout: () => 0,
  };

  const sink = await openDownloadSink('book.epub', { env });
  assert.equal(sink.kind, 'opfs');
  await sink.write(new Uint8Array(2));
  await sink.close();
  assert.equal(saved.length, 1);
});

test('触发浏览器保存时设置文件名并在稍后释放对象 URL', () => {
  const revoked = [];
  const link = { style: {}, clicked: 0, click() { this.clicked += 1; }, remove() {} };
  const env = {
    URL: { createObjectURL: () => 'blob:9', revokeObjectURL: (url) => revoked.push(url) },
    document: { createElement: () => link, body: { appendChild: () => {} } },
    setTimeout: (fn) => {
      fn();
      return 0;
    },
  };
  triggerBrowserSave({}, 'book.epub', env);
  assert.equal(link.download, 'book.epub');
  assert.equal(link.clicked, 1);
  assert.deepEqual(revoked, ['blob:9']);
});
