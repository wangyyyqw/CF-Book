import { api } from '/api.js';
import { downloadBook } from '/download-core.js';
const $ = (id) => document.getElementById(id);



function log(text) {
  const li = document.createElement('li');
  li.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  $('dlog').appendChild(li);
  $('dlog').scrollTop = $('dlog').scrollHeight;
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

async function loadTasks() {
  const res = await api('/api/upload/list');
  const data = await res.json();
  if (!res.ok || !data.ok) {
    log(`加载失败: ${data.error || res.status}`);
    return;
  }
  const tbody = $('tasks').querySelector('tbody');
  tbody.innerHTML = '';
  for (const u of data.uploads) {
    const tr = document.createElement('tr');
    tr.dataset.uploadId = u.upload_id;
    const status = u.status;
    const done = u.uploaded_chunks || 0;
    const cell = document.createElement('td');
    cell.textContent = u.filename;
    const btn = document.createElement('button');
    btn.textContent = status === 'completed' ? '下载' : `${done}/${u.total_chunks}`;
    btn.disabled = status !== 'completed';
    btn.addEventListener('click', () => {
      btn.disabled = true;
      setProgress(0);
      downloadBook(u.upload_id, u.filename, {
        onProgress: setProgress,
        onMessage: log,
      }).catch((error) => log(`下载失败: ${error.message}`))
        .finally(() => { btn.disabled = false; });
    });
    tr.append(cell, Object.assign(document.createElement('td'), { textContent: fmtSize(u.total_size) }), Object.assign(document.createElement('td'), { textContent: `${u.total_chunks}` }), Object.assign(document.createElement('td'), { textContent: status }), (() => { const d = document.createElement('td'); d.appendChild(btn); return d; })());
    tbody.appendChild(tr);
  }
}

function setProgress(pct) {
  $('dprogress').hidden = false;
  $('dprogress').innerHTML = `<i style="width:${pct}%"></i>`;
}

loadTasks();

// 支持从书库带 ?focus=uploadId 直接触发下载
const focusId = new URLSearchParams(location.search).get('focus');
if (focusId) {
  loadTasks().then(() => {
    const row = document.querySelector(`tr[data-upload-id="${CSS.escape(focusId)}"]`);
    if (row) row.querySelector('button').click();
  });
}
