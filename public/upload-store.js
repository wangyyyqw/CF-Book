// 上传任务在浏览器里的持久化：任务元数据与本地文件分开存放，
// 刷新页面后仍能恢复队列并继续上传。

const DB_NAME = 'cf-book-uploads';
const DB_VERSION = 1;
const TASKS = 'tasks';
const BLOBS = 'blobs';

// 结束后本地文件不再需要，只保留任务记录供查看
export const FINISHED_STATUSES = ['completed', 'cancelled'];

export function createIndexedDbBackend({ factory = globalThis.indexedDB, dbName = DB_NAME } = {}) {
  let dbPromise = null;

  const open = () => {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = factory.open(dbName, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(TASKS)) db.createObjectStore(TASKS, { keyPath: 'id' });
          if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return dbPromise;
  };

  const run = async (storeName, mode, action) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      let request;
      try {
        request = action(tx.objectStore(storeName));
      } catch (error) {
        reject(error);
        return;
      }
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
      if (request) {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      } else {
        tx.oncomplete = () => resolve();
      }
    });
  };

  return {
    get: (storeName, key) => run(storeName, 'readonly', (store) => store.get(key)),
    getAll: (storeName) => run(storeName, 'readonly', (store) => store.getAll()),
    put: (storeName, value, key) => run(storeName, 'readwrite', (store) =>
      (key === undefined ? store.put(value) : store.put(value, key))),
    delete: (storeName, key) => run(storeName, 'readwrite', (store) => store.delete(key)),
  };
}

export function createUploadStore(backend) {
  return {
    async saveTask(task) {
      await backend.put(TASKS, task);
      return task;
    },
    loadTask: (id) => backend.get(TASKS, id),
    loadTasks: () => backend.getAll(TASKS),
    saveFile: (id, file) => backend.put(BLOBS, file, id),
    loadFile: (id) => backend.get(BLOBS, id),
    async remove(id) {
      await backend.delete(TASKS, id);
      await backend.delete(BLOBS, id);
    },
    // 清掉已经结束的任务记录与本地文件副本，返回清理数量
    async clearFinished(statuses = FINISHED_STATUSES) {
      const tasks = await backend.getAll(TASKS);
      let removed = 0;
      for (const task of tasks) {
        if (!statuses.includes(task.status)) continue;
        await backend.delete(TASKS, task.id);
        await backend.delete(BLOBS, task.id);
        removed += 1;
      }
      return removed;
    },
  };
}

export function openUploadStore(options) {
  return createUploadStore(createIndexedDbBackend(options));
}

// 隐私模式或浏览器禁用 IndexedDB 时的降级：功能可用，但刷新后不保留任务。
export function createMemoryBackend() {
  const stores = { [TASKS]: new Map(), [BLOBS]: new Map() };
  return {
    async get(storeName, key) {
      return stores[storeName].get(key) ?? null;
    },
    async getAll(storeName) {
      return [...stores[storeName].values()];
    },
    async put(storeName, value, key) {
      stores[storeName].set(key === undefined ? value.id : key, value);
    },
    async delete(storeName, key) {
      stores[storeName].delete(key);
    },
  };
}
