import { api } from '/api.js';
import { extractFileMetadata, extractCoverFromFile } from '/metadata.js';
import { readJsonResponse, responseError, wait } from '/upload-http.js';
import { openUploadStore, createUploadStore, createMemoryBackend } from '/upload-store.js';
import { createUploadCenter } from '/upload-manager.js';
import { formatBytes, formatDuration, formatSpeed } from '/format.js';
import { buildImportReport, matchesFilter, REPORT_FILTERS } from '/import-report.js';

const $ = (id) => document.getElementById(id);

const STATUS_TEXT = {
  pending: '等待上传',
  uploading: '上传中',
  paused: '已暂停',
  failed: '失败',
  completed: '已入库',
  cancelled: '已取消',
};

const queueEl = $('upload-queue');
const logEl = $('log');
const summaryEl = $('queue-summary');
const nodes = new Map();
let activeFilter = '';

function log(text) {
  const li = document.createElement('li');
  li.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  logEl.appendChild(li);
  logEl.scrollTop = logEl.scrollHeight;
}

// 存储不可用时（隐私模式、浏览器禁用 IndexedDB）退回内存，功能仍可用但不跨刷新
function openStore() {
  try {
    if (globalThis.indexedDB) return openUploadStore();
    log('浏览器不支持 IndexedDB，任务只在当前页面保留');
  } catch (error) {
    log(`本地任务存储不可用：${error.message}`);
  }
  return createUploadStore(createMemoryBackend());
}

// 用 Canvas 把封面压缩为 WebP（最长边限制），大幅减小存储
async function compressCover(bytes, mime) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('图片解码失败'));
      el.src = url;
    });
    const MAX = 500;
    const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(img, 0, 0, width, height);
    return await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) return reject(new Error('WebP 编码失败'));
        blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer))).catch(reject);
      }, 'image/webp', 0.8);
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

// 外链封面交给服务端抓取；内嵌封面压缩后上传
async function attachCover(bookId, cover, signal) {
  if (cover.url) {
    const form = new FormData();
    form.append('sourceUrl', cover.url);
    const res = await api(`/api/books/${bookId}/cover`, { method: 'POST', body: form, signal });
    if (!res.ok) throw new Error('外链封面抓取失败');
    return;
  }
  let bytes = cover.bytes;
  try {
    bytes = await compressCover(cover.bytes, cover.mime);
  } catch {
    // 压缩失败时直接上传原图
  }
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'image/webp' }), 'cover.webp');
  const res = await api(`/api/books/${bookId}/cover`, { method: 'POST', body: form, signal });
  if (!res.ok) throw new Error('封面上传失败');
}

const center = createUploadCenter({
  store: openStore(),
  api,
  readJsonResponse,
  responseError,
  wait,
  extractMetadata: extractFileMetadata,
  extractCover: extractCoverFromFile,
  attachCover,
  onLog: log,
  onChange: (task) => {
    if (task) {
      if (matchesFilter(task, activeFilter)) renderTask(task);
      else {
        nodes.get(task.id)?.li.remove();
        nodes.delete(task.id);
      }
    }
    renderSummary();
    renderReport();
  },
});

function renderSummary() {
  const tasks = center.list();
  const active = tasks.filter((task) => task.status === 'uploading' || task.status === 'pending').length;
  summaryEl.textContent = tasks.length
    ? `全部 ${tasks.length} 本，进行中 ${active} 本${activeFilter ? ` · 当前筛选 ${tasks.filter((task) => matchesFilter(task, activeFilter)).length} 本` : ''}`
    : '还没有上传任务，先选择文件。';
}

const filterButtons = new Map();
for (const { key, label } of REPORT_FILTERS) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.addEventListener('click', () => {
    activeFilter = key;
    renderAll();
  });
  $('report-filters').appendChild(button);
  filterButtons.set(key, button);
}

function renderReport() {
  const tasks = center.list();
  $('report-panel').hidden = tasks.length === 0;
  for (const [key, button] of filterButtons) {
    button.classList.toggle('active', key === activeFilter);
    button.setAttribute('aria-pressed', String(key === activeFilter));
  }
  if (!tasks.length) return;

  const report = buildImportReport(tasks);
  const counts = [
    ['成功', report.completed],
    ['失败', report.failed],
    ['缺少封面', report.missingCover],
    ['元数据不完整', report.incompleteMeta],
  ];
  $('report-counts').innerHTML = counts
    .map(([label, value]) => `<li><span>${label}</span><strong>${value} 本</strong></li>`)
    .join('');
}

function progressPercent(task) {
  if (!task.totalBytes) return 0;
  return Math.min(100, Math.max(0, (task.uploadedBytes / task.totalBytes) * 100));
}

function buildNode(task) {
  const li = document.createElement('li');
  li.className = 'task-item';
  li.dataset.taskId = task.id;
  li.innerHTML = `
    <div class="task-head">
      <span class="task-name"></span>
      <span class="task-status"></span>
    </div>
    <div class="progress"><i></i></div>
    <div class="task-meta"></div>
    <div class="row-actions"></div>`;
  queueEl.appendChild(li);
  return {
    li,
    name: li.querySelector('.task-name'),
    status: li.querySelector('.task-status'),
    bar: li.querySelector('.progress > i'),
    meta: li.querySelector('.task-meta'),
    actions: li.querySelector('.row-actions'),
  };
}

function actionButton(label, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.addEventListener('click', handler);
  return button;
}

function describeMeta(task) {
  const parts = [`${formatBytes(task.uploadedBytes)} / ${formatBytes(task.totalBytes)}`];
  if (task.totalChunks) parts.push(`分块 ${task.doneChunks}/${task.totalChunks}`);
  if (task.status === 'uploading') {
    parts.push(formatSpeed(task.speed));
    if (task.speed > 0) {
      parts.push(`剩余约 ${formatDuration((task.totalBytes - task.uploadedBytes) / task.speed)}`);
    }
  }
  if (task.failedChunks.length) parts.push(`失败分块 ${task.failedChunks.map((i) => i + 1).join('、')}`);
  if (task.verify?.checked) {
    parts.push(task.verify.bad ? `校验异常 ${task.verify.bad} 块` : `校验 ${task.verify.ok}/${task.verify.total} 通过`);
  } else if (task.verify && !task.verify.checked) {
    parts.push('校验未完成');
  }
  if (task.error) parts.push(task.error);
  return parts.join(' · ');
}

function renderTask(task) {
  const node = nodes.get(task.id) || buildNode(task);
  nodes.set(task.id, node);
  node.name.textContent = task.filename;
  node.name.title = task.filename;
  node.status.textContent = STATUS_TEXT[task.status] || task.status;
  node.status.dataset.status = task.status;
  node.bar.style.width = `${progressPercent(task)}%`;
  node.meta.textContent = describeMeta(task);

  node.actions.replaceChildren();
  const startable = task.status === 'pending' || task.status === 'paused' || task.status === 'failed';
  if (startable) {
    const label = task.status === 'failed' && task.failedChunks.length
      ? `重试失败分块（${task.failedChunks.length}）`
      : task.status === 'failed' ? '重试' : '开始';
    node.actions.append(actionButton(label, () => center.start(task.id)));
  }
  if (task.status === 'uploading' || task.status === 'pending') {
    node.actions.append(actionButton('暂停', () => center.pause(task.id)));
  }
  if (task.uploadId && task.status === 'completed') {
    node.actions.append(actionButton('重新校验', () => center.verify(task.id)));
  }
  if (task.status !== 'completed' && task.status !== 'cancelled') {
    node.actions.append(actionButton('取消', () => center.cancel(task.id)));
  }
  node.actions.append(actionButton('移除', async () => {
    await center.remove(task.id);
    nodes.get(task.id)?.li.remove();
    nodes.delete(task.id);
    renderSummary();
  }));
}

function renderAll() {
  const list = center.list().filter((task) => matchesFilter(task, activeFilter));
  const alive = new Set(list.map((task) => task.id));
  for (const [id, node] of nodes) {
    if (!alive.has(id)) {
      node.li.remove();
      nodes.delete(id);
    }
  }
  for (const task of list) renderTask(task);
  renderSummary();
  renderReport();
}

$('file').addEventListener('change', async (event) => {
  const files = [...event.target.files];
  event.target.value = '';
  if (!files.length) return;
  const added = await center.addFiles(files);
  $('file-summary').textContent = `已加入 ${added.length} 本，点“开始”或“全部开始”后上传。`;
  renderAll();
});

$('start-all').addEventListener('click', () => {
  for (const task of center.list()) {
    if (task.status === 'pending' || task.status === 'paused' || task.status === 'failed') center.start(task.id);
  }
});
$('pause-all').addEventListener('click', () => {
  for (const task of center.list()) center.pause(task.id);
});
$('cleanup-stale').addEventListener('click', async () => {
  try {
    await center.cleanupStaleTasks();
  } catch (error) {
    log(`清理失败：${error.message}`);
  }
});
$('clear-finished').addEventListener('click', async () => {
  const removed = await center.clearFinished();
  for (const [id, node] of nodes) {
    node.li.remove();
    nodes.delete(id);
  }
  renderAll();
  log(`已清理 ${removed} 个已结束的本地任务`);
});

window.addEventListener('beforeunload', (event) => {
  const busy = center.list().some((task) => task.status === 'uploading' || task.status === 'pending');
  if (!busy) return;
  event.preventDefault();
  event.returnValue = '';
});

await center.load();
renderAll();
log('任务列表已从浏览器恢复，未完成的任务可继续上传');
