// 流式下载的底层原语：按顺序把分块写入目标，避免整本书留在浏览器内存里。
// 这里不依赖任何应用模块，便于在 Node 里直接测试。

const DEFAULT_WINDOW = 3;

// 探测当前浏览器可用的写入方式，顺序即优先级：文件系统访问 API → OPFS → 内存 Blob。
export function sinkSupport(env = globalThis) {
  return {
    fileSystemAccess: typeof env.showSaveFilePicker === 'function',
    opfs: Boolean(env.navigator?.storage?.getDirectory),
  };
}

// 触发浏览器保存：把 Blob（或 OPFS 的 File，浏览器会从磁盘流式读取）交给下载链
export function triggerBrowserSave(blob, filename, env = globalThis) {
  const url = env.URL.createObjectURL(blob);
  const link = env.document.createElement('a');
  link.href = url;
  link.download = filename || 'download';
  link.style.display = 'none';
  env.document.body.appendChild(link);
  link.click();
  link.remove();
  // 大文件写入磁盘需要时间，过早撤销会让下载中断
  env.setTimeout(() => env.URL.revokeObjectURL(url), 60000);
}

async function openFileSystemAccessSink(filename, env) {
  const handle = await env.showSaveFilePicker({ suggestedName: filename });
  const writable = await handle.createWritable();
  return {
    kind: 'file-system-access',
    async write(chunk) {
      await writable.write(chunk);
    },
    async close() {
      await writable.close();
    },
    async abort() {
      await writable.abort().catch(() => {});
    },
  };
}

async function openOpfsSink(filename, env) {
  const root = await env.navigator.storage.getDirectory();
  const tempName = `cfbook-${env.crypto.randomUUID()}.part`;
  const handle = await root.getFileHandle(tempName, { create: true });
  const writable = await handle.createWritable();
  const cleanup = async () => {
    await root.removeEntry(tempName).catch(() => {});
  };
  return {
    kind: 'opfs',
    async write(chunk) {
      await writable.write(chunk);
    },
    async close() {
      await writable.close();
      // OPFS 的 File 由磁盘支撑，交给浏览器后不会整体读进内存
      triggerBrowserSave(await handle.getFile(), filename, env);
      env.setTimeout(() => cleanup(), 10000);
    },
    async abort() {
      await writable.abort().catch(() => {});
      await cleanup();
    },
  };
}

function openBlobSink(filename, env) {
  const parts = [];
  return {
    kind: 'blob',
    async write(chunk) {
      parts.push(chunk);
    },
    async close() {
      triggerBrowserSave(new env.Blob(parts, { type: 'application/octet-stream' }), filename, env);
    },
    async abort() {
      parts.length = 0;
    },
  };
}

// 用户点击下载时优先弹系统保存框；自动/排队下载没有用户手势，只能走 OPFS 或内存。
export async function openDownloadSink(filename, { preferFilePicker = false, env = globalThis } = {}) {
  const support = sinkSupport(env);
  if (preferFilePicker && support.fileSystemAccess) {
    try {
      return await openFileSystemAccessSink(filename, env);
    } catch (error) {
      // 用户主动取消保存框时不要静默改存到别处
      if (error?.name === 'AbortError') throw error;
    }
  }
  if (support.opfs && typeof env.crypto?.randomUUID === 'function') {
    try {
      return await openOpfsSink(filename, env);
    } catch {
      // OPFS 在隐私模式或配额不足时会失败，退回内存合并
    }
  }
  return openBlobSink(filename, env);
}

// 清掉上次会话残留的 OPFS 临时文件；一小时内的文件可能是其他标签页正在写入的。
export async function cleanupStaleOpfsFiles(env = globalThis, { maxAgeMs = 60 * 60 * 1000 } = {}) {
  if (!env.navigator?.storage?.getDirectory) return 0;
  try {
    const root = await env.navigator.storage.getDirectory();
    const now = env.Date.now();
    let removed = 0;
    for await (const [name, handle] of root.entries()) {
      if (handle.kind !== 'file' || !name.startsWith('cfbook-')) continue;
      const file = await handle.getFile().catch(() => null);
      if (file && now - file.lastModified > maxAgeMs) {
        await root.removeEntry(name).catch(() => {});
        removed += 1;
      }
    }
    return removed;
  } catch {
    return 0;
  }
}

// 并发抓取分块、严格按序号写入。窗口上限保证内存里最多只有 windowSize 个分块。
export async function runDownload({
  chunks,
  sink,
  fetchChunk,
  signal,
  windowSize = DEFAULT_WINDOW,
  onProgress = () => {},
}) {
  const total = chunks.length;
  const totalBytes = chunks.reduce((sum, chunk) => sum + (Number(chunk.size) || 0), 0);
  const buffer = new Map();
  let waiters = [];
  const wake = () => {
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) resolve();
  };
  const wait = () => new Promise((resolve) => waiters.push(resolve));
  const throwIfAborted = () => {
    if (signal?.aborted) throw new DOMException('下载已中止', 'AbortError');
  };

  const limit = Math.max(1, Math.min(Number(windowSize) || DEFAULT_WINDOW, total || 1));
  let nextFetch = 0;
  let nextWrite = 0;
  let downloadedBytes = 0;

  const writer = async () => {
    while (nextWrite < total) {
      throwIfAborted();
      if (!buffer.has(nextWrite)) {
        await wait();
        continue;
      }
      const bytes = buffer.get(nextWrite);
      buffer.delete(nextWrite);
      await sink.write(bytes);
      nextWrite += 1;
      downloadedBytes += Number(bytes.byteLength ?? bytes.length) || 0;
      onProgress({ done: nextWrite, total, downloadedBytes, totalBytes });
      wake();
    }
  };

  const fetcher = async () => {
    while (true) {
      throwIfAborted();
      if (nextFetch >= total) return;
      if (nextFetch - nextWrite >= limit) {
        await wait();
        continue;
      }
      const index = nextFetch;
      nextFetch += 1;
      const bytes = await fetchChunk(chunks[index], index);
      buffer.set(index, bytes);
      wake();
    }
  };

  await Promise.all([...Array.from({ length: limit }, fetcher), writer()]);
  return { total, totalBytes, downloadedBytes };
}
