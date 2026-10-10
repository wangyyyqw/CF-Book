import { api } from '/api.js';
import { downloadBook } from '/download-core.js';
import { createDownloadQueue } from '/download-queue.js';
import { cleanupStaleOpfsFiles } from '/download-stream.js';
import { formatBytes, formatDuration, formatSpeed } from '/format.js';

const $ = (id) => document.getElementById(id);
const CONCURRENCY_KEY = 'cf-book-download-concurrency';
const HISTORY_KEY = 'cf-book-download-history';
const HISTORY_LIMIT = 50;

const STATUS_TEXT = {
  queued: '排队中',
  running: '下载中',
  paused: '已暂停',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
};
const UPLOAD_STATUS_TEXT = { completed: '已入库', active: '上传中', aborted: '已中止' };

const queueEl = $('download-queue');
const historyEl = $('download-history');
const summaryEl = $('queue-summary');
const queueNodes = new Map();
let uploads = [];

function readConcurrency() {
  const saved = Number(localStorage.getItem(CONCURRENCY_KEY));
  return saved >= 1 && saved <= 4 ? saved : 2;
}

function readHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

let history = readHistory();

function saveHistory() {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, HISTORY_LIMIT)));
}

const queue = createDownloadQueue({
  concurrency: readConcurrency(),
  download: (task, { signal, onProgress }) => downloadBook(task.uploadId, task.filename, {
    signal,
    onProgress,
    preferFilePicker: task.preferFilePicker,
  }),
  onChange: (task) => {
    if (task) renderTask(task);
    renderSummary();
  },
  onHistory: (entry) => {
    history = [entry, ...history].slice(0, HISTORY_LIMIT);
    saveHistory();
    renderHistory();
  },
});

$('concurrency').value = String(queue.concurrency());

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function renderSummary() {
  const tasks = queue.tasks();
  const active = tasks.filter((task) => task.status === 'running' || task.status === 'queued').length;
  summaryEl.textContent = tasks.length
    ? `队列 ${tasks.length} 项，进行中 ${active} 项`
    : '队列为空，可从下方已入库任务加入。';
}

function etaText(task) {
  if (task.status !== 'running' || !task.speed || !task.totalBytes) return '';
  const remaining = Math.max(0, task.totalBytes - task.downloadedBytes);
  return ` · 剩余约 ${formatDuration(remaining / task.speed)}`;
}

function buildTaskNode(task) {
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

function removeTaskNode(id) {
  queueNodes.get(id)?.li.remove();
  queueNodes.delete(id);
}

function renderTask(task) {
  const node = queueNodes.get(task.id) || buildTaskNode(task);
  queueNodes.set(task.id, node);
  node.name.textContent = task.filename;
  node.name.title = task.filename;
  node.status.textContent = STATUS_TEXT[task.status] || task.status;
  node.status.dataset.status = task.status;
  node.bar.style.width = `${Math.min(100, Math.max(0, task.percent || 0))}%`;

  const parts = [
    `${formatBytes(task.downloadedBytes)} / ${formatBytes(task.totalBytes)}`,
    `${(task.percent || 0).toFixed(0)}%`,
  ];
  if (task.status === 'running') parts.push(formatSpeed(task.speed));
  node.meta.textContent = task.status === 'failed' && task.error
    ? `${parts.join(' · ')} · ${task.error}`
    : parts.join(' · ') + etaText(task);

  node.actions.replaceChildren();
  if (task.status === 'running' || task.status === 'queued') {
    node.actions.append(actionButton('暂停', () => queue.pause(task.id)));
  }
  if (task.status === 'paused') {
    node.actions.append(actionButton('继续', () => queue.resume(task.id)));
  }
  if (task.status === 'failed' || task.status === 'cancelled') {
    node.actions.append(actionButton('重试', () => queue.retry(task.id)));
  }
  if (task.status !== 'done' && task.status !== 'cancelled') {
    node.actions.append(actionButton('取消', () => queue.cancel(task.id)));
  }
  if (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') {
    node.actions.append(actionButton('移除', () => {
      removeTaskNode(task.id);
      queue.clearFinished();
      renderSummary();
    }));
  }
}

function renderHistory() {
  if (!history.length) {
    historyEl.innerHTML = '<li class="muted">还没有下载记录。</li>';
    return;
  }
  historyEl.innerHTML = history.map((entry) => {
    const time = entry.finishedAt ? new Date(entry.finishedAt).toLocaleString() : '';
    const tail = entry.status === 'failed' && entry.error ? ` · ${entry.error}` : '';
    return `<li class="task-item history-item">
      <div class="task-head"><span class="task-name">${escapeHtml(entry.filename)}</span><span class="task-status" data-status="${escapeHtml(entry.status)}">${STATUS_TEXT[entry.status] || escapeHtml(entry.status)}</span></div>
      <div class="task-meta">${formatBytes(entry.size)} · ${escapeHtml(time)}${escapeHtml(tail)}</div>
    </li>`;
  }).join('');
}

function enqueue(upload, { preferFilePicker = false } = {}) {
  return queue.add({
    uploadId: upload.upload_id,
    filename: upload.filename,
    size: upload.total_size,
    preferFilePicker: preferFilePicker && queue.activeCount() === 0,
  });
}

function renderTasks() {
  const keyword = $('task-search').value.trim().toLowerCase();
  const status = $('task-status').value;
  const tbody = $('tasks').querySelector('tbody');
  tbody.replaceChildren();

  const visible = uploads.filter((upload) =>
    (!status || upload.status === status) &&
    (!keyword || String(upload.filename).toLowerCase().includes(keyword)));

  for (const upload of visible) {
    const tr = document.createElement('tr');
    tr.dataset.uploadId = upload.upload_id;
    tr.append(
      Object.assign(document.createElement('td'), { textContent: upload.filename }),
      Object.assign(document.createElement('td'), { textContent: formatBytes(upload.total_size) }),
      Object.assign(document.createElement('td'), {
        textContent: `${upload.uploaded_chunks || 0}/${upload.total_chunks}`,
      }),
      Object.assign(document.createElement('td'), { textContent: UPLOAD_STATUS_TEXT[upload.status] || upload.status }),
    );
    const cell = document.createElement('td');
    const button = document.createElement('button');
    const completed = upload.status === 'completed';
    button.textContent = completed ? '加入下载队列' : '未完成';
    button.disabled = !completed;
    button.addEventListener('click', () => {
      enqueue(upload, { preferFilePicker: true });
      $('tasks-msg').textContent = `已加入队列：${upload.filename}`;
    });
    cell.appendChild(button);
    tr.appendChild(cell);
    ['文件名', '大小', '分块', '状态', '操作'].forEach((label, index) => {
      tr.cells[index].dataset.label = label;
    });
    tbody.appendChild(tr);
  }
  $('tasks-msg').textContent = visible.length ? `共 ${visible.length} 个任务` : '没有匹配的任务。';
}

async function loadTasks() {
  const res = await api('/api/upload/list');
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    $('tasks-msg').textContent = `加载失败：${data.error || res.status}`;
    return;
  }
  uploads = data.uploads || [];
  renderTasks();
}

$('concurrency').addEventListener('change', (event) => {
  const value = queue.setConcurrency(event.target.value);
  localStorage.setItem(CONCURRENCY_KEY, String(value));
});
$('pause-all').addEventListener('click', () => queue.pauseAll());
$('resume-all').addEventListener('click', () => queue.resumeAll());
$('clear-finished').addEventListener('click', () => {
  for (const task of queue.tasks()) {
    if (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') removeTaskNode(task.id);
  }
  queue.clearFinished();
  renderSummary();
});
$('task-search').addEventListener('input', renderTasks);
$('task-status').addEventListener('change', renderTasks);
$('queue-all-completed').addEventListener('click', () => {
  const completed = uploads.filter((upload) => upload.status === 'completed');
  for (const upload of completed) enqueue(upload);
  $('tasks-msg').textContent = `已加入 ${completed.length} 个已入库任务`;
});

window.addEventListener('beforeunload', (event) => {
  if (!queue.hasActive()) return;
  event.preventDefault();
  event.returnValue = '';
});

cleanupStaleOpfsFiles();
renderHistory();
renderSummary();
loadTasks().then(() => {
  const focusId = new URLSearchParams(location.search).get('focus');
  if (!focusId) return;
  const upload = uploads.find((item) => item.upload_id === focusId);
  if (upload) enqueue(upload);
});
