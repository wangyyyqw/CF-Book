import { api } from '/api.js';
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
    btn.addEventListener('click', () => downloadBook(u.upload_id, u.filename));
    tr.append(cell, Object.assign(document.createElement('td'), { textContent: fmtSize(u.total_size) }), Object.assign(document.createElement('td'), { textContent: `${u.total_chunks}` }), Object.assign(document.createElement('td'), { textContent: status }), (() => { const d = document.createElement('td'); d.appendChild(btn); return d; })());
    tbody.appendChild(tr);
  }
}

async function downloadBook(uploadId, filename) {
  const metaRes = await api(`/api/download/${uploadId}`);
  const meta = await metaRes.json();
  if (!metaRes.ok || !meta.ok) {
    log(`获取书籍信息失败: ${meta.error || metaRes.status}`);
    return;
  }

  // 并发下载分块（按 index 顺序填入数组，避免乱序）
  const parts = new Array(meta.chunks.length);
  const DOWNLOAD_CONCURRENCY = 3;
  let done = 0;
  const getChunk = async (c) => {
    const res = await api(`/api/download/${uploadId}/chunk/${c.index}`);
    if (!res.ok) {
      throw new Error(`分块 ${c.index + 1} 下载失败: ${res.status}`);
    }
    const bytes = await res.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    if (hex !== c.sha256) {
      throw new Error(`分块 ${c.index + 1} 哈希校验失败`);
    }
    parts[c.index] = bytes;
    done++;
    setProgress((done / meta.chunks.length) * 100);
  };
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= meta.chunks.length) return;
      await getChunk(meta.chunks[i]);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, meta.chunks.length) }, worker));
  } catch (e) {
    log(e.message);
    return;
  }

  const blob = new Blob(parts, { type: 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
  log('下载完成，浏览器已保存合并后的文件');
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
