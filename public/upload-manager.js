// 上传任务中心的编排：任务列表、暂停/继续、取消、失败分块重试、速度统计与上传后校验。
// 不接触 DOM，网络层与元数据提取由调用方注入，便于在 Node 里测试。

const DEFAULT_CHUNK_SIZE = 16 * 1024 * 1024;
const DEFAULT_HASH_LIMIT = 1024 * 1024 * 1024;
const SPEED_SMOOTHING = 0.4;

const RECORD_FIELDS = [
  'id', 'uploadId', 'filename', 'size', 'mime', 'sha256', 'meta', 'warning', 'hasCover', 'status', 'error',
  'chunkSize', 'totalChunks', 'doneChunks', 'uploadedBytes', 'totalBytes', 'failedChunks',
  'bookId', 'verify', 'createdAt', 'updatedAt',
];

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function abortError() {
  return new DOMException('上传已中止', 'AbortError');
}

export async function sha256OfBlob(blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function newId() {
  return globalThis.crypto?.randomUUID
    ? crypto.randomUUID()
    : `up-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function createUploadCenter({
  store,
  api,
  readJsonResponse,
  responseError,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  extractMetadata = async () => ({}),
  extractCover = async () => null,
  attachCover = async () => {},
  hashFile = sha256OfBlob,
  now = () => Date.now(),
  onChange = () => {},
  onLog = () => {},
  concurrency = 5,
  chunkSize = DEFAULT_CHUNK_SIZE,
  chunkRetries = 3,
  hashLimit = DEFAULT_HASH_LIMIT,
} = {}) {
  const tasks = new Map();
  const files = new Map();
  const controllers = new Map();
  let runningTask = null;
  let idleResolvers = [];

  const emit = (task) => onChange(task, [...tasks.values()]);

  function toRecord(task) {
    const record = {};
    for (const field of RECORD_FIELDS) record[field] = task[field];
    return record;
  }

  async function persist(task) {
    task.updatedAt = now();
    await store.saveTask(toRecord(task));
  }

  function chunkBytes(task, index) {
    if (index === task.totalChunks - 1) return task.size - index * task.chunkSize;
    return task.chunkSize;
  }

  function updateSpeed(task) {
    const time = now();
    if (!task.lastTick) {
      task.lastTick = { time, bytes: task.uploadedBytes };
      return;
    }
    const seconds = (time - task.lastTick.time) / 1000;
    if (seconds < 0.3) return;
    const instant = (task.uploadedBytes - task.lastTick.bytes) / seconds;
    task.speed = task.lastTick.smoothed == null
      ? instant
      : task.lastTick.smoothed * SPEED_SMOOTHING + instant * (1 - SPEED_SMOOTHING);
    task.lastTick = { time, bytes: task.uploadedBytes, smoothed: task.speed };
  }

  async function postJson(url, body, signal) {
    const res = await api(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    const data = await readJsonResponse(res, '上传请求');
    if (!res.ok || !data.ok) throw responseError(res, data, '上传请求');
    return data;
  }

  function makeTask(file) {
    return {
      id: newId(),
      uploadId: '',
      filename: file.name,
      size: file.size,
      mime: file.type || 'application/octet-stream',
      sha256: '',
      meta: null,
      warning: '',
      hasCover: null,
      status: 'pending',
      error: '',
      chunkSize,
      totalChunks: 0,
      doneChunks: 0,
      uploadedBytes: 0,
      totalBytes: file.size,
      failedChunks: [],
      bookId: '',
      verify: null,
      createdAt: now(),
      updatedAt: now(),
      // 以下字段只在内存中存在，不写入存储
      cover: null,
      speed: 0,
      lastTick: null,
      abortIntent: null,
    };
  }

  async function safeExtract(fn, onError = () => {}) {
    try {
      return await fn();
    } catch (error) {
      const message = messageOf(error);
      onError(message);
      onLog(`元数据提取失败（不影响上传）：${message}`);
      return null;
    }
  }

  async function uploadChunk(task, file, index, signal) {
    const start = index * task.chunkSize;
    const blob = file.slice(start, start + chunkBytes(task, index));
    let lastError;
    for (let attempt = 1; attempt <= chunkRetries; attempt += 1) {
      if (signal?.aborted) throw abortError();
      try {
        const form = new FormData();
        form.append('uploadId', task.uploadId);
        form.append('index', String(index));
        form.append('file', blob, `${task.filename}.part${String(index).padStart(3, '0')}`);
        const res = await api('/api/upload/chunk', { method: 'POST', body: form, signal });
        const data = await readJsonResponse(res, `分块 ${index + 1}/${task.totalChunks}`);
        if (!res.ok || !data.ok) throw responseError(res, data, `分块 ${index + 1}/${task.totalChunks}`);
        return;
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        lastError = error;
        if (error && typeof error === 'object' && (error.name === 'TypeError' || !('retryable' in error))) {
          error.retryable = true;
        }
        if (!error?.retryable || attempt === chunkRetries) throw error;
        onLog(`[${task.filename}] 分块 ${index + 1} 第 ${attempt} 次失败，${attempt + 1} 秒后重试…`);
        await wait(attempt * 1000);
      }
    }
    throw lastError;
  }

  async function verifyTask(task, signal) {
    try {
      const res = await api(`/api/upload/${encodeURIComponent(task.uploadId)}/verify`, { method: 'POST', signal });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) return { checked: false, error: data.error || `HTTP ${res.status}` };
      const { total, ok, bad } = data.verified;
      onLog(`[${task.filename}] 已校验 ${ok}/${total} 个 Telegram 分块${bad ? `，异常 ${bad} 块` : ''}`);
      return { ...data.verified, checked: true };
    } catch (error) {
      return { checked: false, error: messageOf(error) };
    }
  }

  async function runTask(task) {
    const file = files.get(task.id) || (await store.loadFile(task.id));
    if (!file) {
      task.status = 'failed';
      task.error = '本地文件副本已丢失，请重新选择该文件后再试';
      await persist(task);
      emit(task);
      return;
    }
    files.set(task.id, file);

    const controller = new AbortController();
    controllers.set(task.id, controller);
    const signal = controller.signal;
    task.status = 'uploading';
    task.error = '';
    task.failedChunks = [];
    task.speed = 0;
    task.lastTick = null;
    task.abortIntent = null;
    await persist(task);
    emit(task);

    try {
      if (!task.sha256 && file.size <= hashLimit) {
        onLog(`[${task.filename}] 计算文件 SHA-256（大文件需要一点时间）…`);
        task.sha256 = await hashFile(file);
        await persist(task);
      } else if (!task.sha256) {
        onLog(`[${task.filename}] 超过 1GB，跳过整书哈希，分块哈希仍会校验`);
      }
      if (!task.meta) {
        let errorMessage = '';
        task.meta = (await safeExtract(
          () => extractMetadata(file, file.name),
          (message) => { errorMessage = message; },
        )) || {};
        task.warning = [task.warning, task.meta.warning, errorMessage && `元数据识别失败：${errorMessage}`]
          .filter(Boolean).join('；');
        if (task.meta.title) onLog(`[${task.filename}] 识别书名：${task.meta.title}`);
        await persist(task);
      }
      // 暂停、刷新或分块失败后，封面 bytes 不在任务记录里；未入库前必须重新从本地文件提取。
      if (!task.bookId) {
        let errorMessage = '';
        task.cover = await safeExtract(
          () => extractCover(file, file.name),
          (message) => { errorMessage = message; },
        );
        task.hasCover = Boolean(task.cover?.bytes || task.cover?.url);
        if (errorMessage) task.warning = [task.warning, `封面识别失败：${errorMessage}`].filter(Boolean).join('；');
        await persist(task);
      }

      const init = await postJson('/api/upload/init', {
        filename: file.name,
        size: file.size,
        mime: task.mime,
        chunkSize: task.chunkSize,
        sha256: task.sha256,
        meta: task.meta,
      }, signal);
      task.uploadId = init.uploadId;
      task.chunkSize = Number(init.chunkSize) || task.chunkSize;
      task.totalChunks = Number(init.totalChunks) || Math.ceil(file.size / task.chunkSize);
      const uploaded = new Set((init.uploadedChunks || []).map(Number));
      task.doneChunks = uploaded.size;
      task.uploadedBytes = [...uploaded].reduce((sum, index) => sum + chunkBytes(task, index), 0);
      if (init.resumed) {
        onLog(`[${task.filename}] 继续未完成任务：已完成 ${uploaded.size}/${task.totalChunks} 块`);
      }
      await persist(task);
      emit(task);

      const pending = [];
      for (let index = 0; index < task.totalChunks; index += 1) {
        if (!uploaded.has(index)) pending.push(index);
      }

      let cursor = 0;
      const worker = async () => {
        while (cursor < pending.length) {
          const index = pending[cursor];
          cursor += 1;
          try {
            await uploadChunk(task, file, index, signal);
            task.doneChunks += 1;
            task.uploadedBytes += chunkBytes(task, index);
            updateSpeed(task);
            emit(task);
            if (task.doneChunks % 5 === 0 || task.doneChunks === task.totalChunks) {
              onLog(`[${task.filename}] 分块 ${task.doneChunks}/${task.totalChunks} 已完成`);
            }
          } catch (error) {
            if (error?.name === 'AbortError') throw error;
            // 单个分块失败不中断整本书，记录下来供“只重试失败分块”使用
            task.failedChunks.push(index);
            onLog(`[${task.filename}] 分块 ${index + 1} 失败：${messageOf(error)}`);
            emit(task);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
      if (signal.aborted) throw abortError();

      if (task.failedChunks.length) {
        task.status = 'failed';
        task.error = `${task.failedChunks.length} 个分块上传失败，可只重试这些分块`;
        return;
      }

      const done = await postJson('/api/upload/complete', {
        uploadId: task.uploadId,
        sha256: task.sha256,
        meta: task.meta,
      }, signal);
      task.bookId = done.bookId || '';
      task.status = 'completed';
      task.speed = 0;
      onLog(`[${task.filename}] 入库完成，可在“下载”页找到该书`);
      if (task.cover && task.bookId) {
        try {
          await attachCover(task.bookId, task.cover, signal);
          onLog(`[${task.filename}] 封面已保存`);
        } catch (error) {
          onLog(`[${task.filename}] 封面上传失败（不影响入库）：${messageOf(error)}`);
        }
      }
      task.verify = await verifyTask(task, signal);
    } catch (error) {
      if (signal.aborted) {
        task.status = task.abortIntent === 'cancel' ? 'cancelled' : 'paused';
        task.speed = 0;
      } else {
        task.status = 'failed';
        task.error = messageOf(error);
      }
    } finally {
      controllers.delete(task.id);
      task.cover = null;
      await persist(task);
      emit(task);
    }
  }

  function checkIdle() {
    const busy = runningTask || [...tasks.values()].some((task) => task.status === 'pending');
    if (busy || !idleResolvers.length) return;
    const resolvers = idleResolvers;
    idleResolvers = [];
    for (const resolve of resolvers) resolve();
  }

  // 上传按任务串行执行，避免多本书同时占满浏览器与 Telegram 上传通道
  function pump() {
    if (runningTask) return;
    const next = [...tasks.values()].find((task) => task.status === 'pending');
    if (!next) {
      checkIdle();
      return;
    }
    runningTask = next.id;
    runTask(next)
      .catch(() => {})
      .finally(() => {
        runningTask = null;
        pump();
      });
  }

  const center = {
    async load() {
      const records = await store.loadTasks();
      for (const record of records.sort((a, b) => a.createdAt - b.createdAt)) {
        const task = {
          ...record,
          failedChunks: record.failedChunks || [],
          warning: record.warning || '',
          cover: null,
          speed: 0,
          lastTick: null,
          abortIntent: null,
          // 刷新前正在上传的任务无法自动续传，交给用户手动继续
          status: record.status === 'uploading' ? 'paused' : record.status,
        };
        tasks.set(task.id, task);
      }
      return center.list();
    },
    list: () => [...tasks.values()].sort((a, b) => a.createdAt - b.createdAt),
    get: (id) => tasks.get(id),
    runningId: () => runningTask,
    whenIdle() {
      return new Promise((resolve) => {
        idleResolvers.push(resolve);
        checkIdle();
      });
    },
    async addFiles(fileList) {
      const added = [];
      for (const file of fileList) {
        const task = makeTask(file);
        tasks.set(task.id, task);
        files.set(task.id, file);
        await store.saveFile(task.id, file);
        await persist(task);
        emit(task);
        added.push(task);
      }
      return added;
    },
    start(id) {
      const task = tasks.get(id);
      if (!task || task.status === 'uploading') return;
      task.status = 'pending';
      task.error = '';
      emit(task);
      pump();
    },
    pause(id) {
      const task = tasks.get(id);
      if (!task) return;
      if (task.status === 'pending') {
        task.status = 'paused';
        emit(task);
        checkIdle();
        return;
      }
      if (task.status !== 'uploading') return;
      task.abortIntent = 'pause';
      controllers.get(id)?.abort();
    },
    async cancel(id) {
      const task = tasks.get(id);
      if (!task || task.status === 'cancelled') return;
      task.abortIntent = 'cancel';
      if (task.status === 'uploading') {
        controllers.get(id)?.abort();
      } else if (task.status === 'pending') {
        task.status = 'cancelled';
        emit(task);
        checkIdle();
      }
      if (task.uploadId) {
        try {
          await postJson('/api/upload/abort', { uploadId: task.uploadId });
        } catch (error) {
          onLog(`[${task.filename}] 通知服务端中止失败：${messageOf(error)}`);
        }
      }
      if (task.status !== 'uploading') await persist(task);
    },
    async remove(id) {
      const task = tasks.get(id);
      if (!task) return;
      if (task.status === 'uploading') await center.cancel(id);
      tasks.delete(id);
      files.delete(id);
      await store.remove(id);
    },
    async verify(id) {
      const task = tasks.get(id);
      if (!task?.uploadId) return null;
      task.verify = await verifyTask(task, undefined);
      emit(task);
      return task.verify;
    },
    async cleanupStaleTasks(days = 30) {
      const data = await postJson('/api/upload/cleanup', { days });
      onLog(`已清理 ${data.deleted} 个空任务，归档 ${data.aborted} 个长期未完成任务`);
      return data;
    },
    async clearFinished() {
      const removed = await store.clearFinished();
      for (const [id, task] of [...tasks]) {
        if (task.status === 'completed' || task.status === 'cancelled') {
          tasks.delete(id);
          files.delete(id);
        }
      }
      emit(null);
      return removed;
    },
  };

  return center;
}
