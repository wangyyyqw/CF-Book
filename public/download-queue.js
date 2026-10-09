// 下载队列：负责并发调度、暂停/继续、失败重试与速度统计。
// 纯逻辑模块，不接触 DOM，方便在 Node 里测试。

const SPEED_SMOOTHING = 0.4;

export function createDownloadQueue({
  download,
  concurrency = 2,
  now = () => Date.now(),
  onChange = () => {},
  onHistory = () => {},
} = {}) {
  const tasks = new Map();
  const controllers = new Map();
  let limit = Math.max(1, Number(concurrency) || 1);
  let running = 0;
  let seq = 0;

  const emit = (task) => onChange(task, [...tasks.values()]);

  function makeTask(input) {
    return {
      id: input.id ?? `dl-${++seq}`,
      uploadId: input.uploadId,
      filename: input.filename || 'download',
      size: Number(input.size) || 0,
      preferFilePicker: Boolean(input.preferFilePicker),
      status: 'queued',
      percent: 0,
      downloadedBytes: 0,
      totalBytes: Number(input.size) || 0,
      speed: 0,
      error: '',
      abortIntent: null,
      addedAt: now(),
      startedAt: 0,
      finishedAt: 0,
      lastTick: null,
    };
  }

  function updateSpeed(task, downloadedBytes) {
    const stamp = now();
    if (!task.lastTick) {
      task.lastTick = { time: stamp, bytes: downloadedBytes };
      return;
    }
    const seconds = (stamp - task.lastTick.time) / 1000;
    if (seconds < 0.3) return;
    const instant = (downloadedBytes - task.lastTick.bytes) / seconds;
    task.speed = task.lastTick.instant == null ? instant : task.lastTick.instant * SPEED_SMOOTHING + instant * (1 - SPEED_SMOOTHING);
    task.lastTick = { time: stamp, bytes: downloadedBytes, instant: task.speed };
  }

  function pump() {
    while (running < limit) {
      const next = [...tasks.values()].find((task) => task.status === 'queued');
      if (!next) return;
      void start(next);
    }
  }

  async function start(task) {
    task.status = 'running';
    task.error = '';
    task.abortIntent = null;
    task.startedAt = now();
    task.lastTick = null;
    running += 1;
    const controller = new AbortController();
    controllers.set(task.id, controller);
    emit(task);

    try {
      await download(task, {
        signal: controller.signal,
        onProgress: (state) => {
          task.downloadedBytes = state.downloadedBytes ?? task.downloadedBytes;
          task.totalBytes = state.totalBytes || task.totalBytes;
          task.percent = state.total ? (state.done / state.total) * 100 : 100;
          updateSpeed(task, task.downloadedBytes);
          emit(task);
        },
      });
      task.status = 'done';
      task.percent = 100;
      task.downloadedBytes = task.totalBytes || task.downloadedBytes;
      task.finishedAt = now();
      task.speed = 0;
    } catch (error) {
      if (task.abortIntent === 'cancel') {
        task.status = 'cancelled';
        task.finishedAt = now();
      } else if (task.abortIntent === 'pause') {
        task.status = 'paused';
        task.speed = 0;
      } else {
        task.status = 'failed';
        task.error = error instanceof Error ? error.message : String(error);
        task.finishedAt = now();
        task.speed = 0;
      }
    } finally {
      running -= 1;
      controllers.delete(task.id);
      emit(task);
      if (task.status === 'done' || task.status === 'failed') {
        onHistory({
          id: task.id,
          uploadId: task.uploadId,
          filename: task.filename,
          size: task.size,
          status: task.status,
          error: task.error,
          finishedAt: task.finishedAt,
        });
      }
      pump();
    }
  }

  return {
    add(input) {
      const task = makeTask(input);
      tasks.set(task.id, task);
      emit(task);
      pump();
      return task;
    },
    get: (id) => tasks.get(id),
    tasks: () => [...tasks.values()],
    concurrency: () => limit,
    setConcurrency(value) {
      limit = Math.max(1, Number(value) || 1);
      pump();
      return limit;
    },
    pause(id) {
      const task = tasks.get(id);
      if (!task || (task.status !== 'running' && task.status !== 'queued')) return;
      if (task.status === 'queued') {
        task.status = 'paused';
        emit(task);
        return;
      }
      task.abortIntent = 'pause';
      controllers.get(id)?.abort();
    },
    resume(id) {
      const task = tasks.get(id);
      if (!task || task.status !== 'paused') return;
      task.status = 'queued';
      emit(task);
      pump();
    },
    retry(id) {
      const task = tasks.get(id);
      if (!task || (task.status !== 'failed' && task.status !== 'cancelled')) return;
      task.status = 'queued';
      task.error = '';
      task.percent = 0;
      task.downloadedBytes = 0;
      emit(task);
      pump();
    },
    cancel(id) {
      const task = tasks.get(id);
      if (!task || task.status === 'done' || task.status === 'cancelled') return;
      if (task.status === 'running') {
        task.abortIntent = 'cancel';
        controllers.get(id)?.abort();
        return;
      }
      task.status = 'cancelled';
      task.finishedAt = now();
      emit(task);
    },
    pauseAll() {
      for (const task of tasks.values()) {
        if (task.status === 'running' || task.status === 'queued') this.pause(task.id);
      }
    },
    resumeAll() {
      for (const task of tasks.values()) {
        if (task.status === 'paused') this.resume(task.id);
      }
    },
    // 只清掉已结束的任务，队列里还有等待/暂停的任务时保留
    clearFinished() {
      for (const [id, task] of tasks) {
        if (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') tasks.delete(id);
      }
      emit(null);
    },
    hasActive: () => [...tasks.values()].some((task) => task.status === 'running' || task.status === 'queued'),
    activeCount: () => [...tasks.values()].filter((task) => task.status === 'running' || task.status === 'queued').length,
  };
}
