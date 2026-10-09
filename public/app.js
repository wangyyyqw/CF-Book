import { extractFileMetadata, extractCoverFromFile } from '/metadata.js';
import { api } from '/api.js';

const CHUNK_SIZE = 16 * 1024 * 1024; // 16MiB，低于 Telegram 20MiB 下载限制
const UPLOAD_CONCURRENCY = 5; // 并发上传分块数（Telegram 不排斥并发，实测并行更快）

const $ = (id) => document.getElementById(id);
const fileEl = $('file');
const startBtn = $('start');
const abortBtn = $('abort');
const progressEl = $('progress');
const speedEl = $('speed');
const logEl = $('log');

function log(text) {
  const li = document.createElement('li');
  li.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  logEl.appendChild(li);
  logEl.scrollTop = logEl.scrollHeight;
}

async function sha256OfFile(file) {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function uploadFile(file) {
  if (!crypto.subtle) {
    throw new Error('当前环境不支持 crypto.subtle，无法计算哈希');
  }
  log('计算文件 SHA-256（大文件需要一点时间）…');
  let fileSha256 = '';
  if (file.size > 1024 * 1024 * 1024) {
    log('超大文件（>1GB）跳过整书哈希计算，分块哈希已保证数据完整性');
  } else {
    fileSha256 = await sha256OfFile(file);
    log(`文件 SHA-256: ${fileSha256.slice(0, 16)}…`);
  }

  // 尝试从文件内部提取元数据（EPUB/PDF/MOBI）
  let meta = { title: '', author: '', format: '', publisher: '', language: '', isbn: '', description: '', date: '' };
  let cover = null;
  try {
    const t0 = performance.now();
    meta = await extractFileMetadata(file, file.name);
    if (meta.title) log(`识别书名：${meta.title}`);
    if (meta.author) log(`识别作者：${meta.author}`);
    if (meta.isbn) log(`识别 ISBN：${meta.isbn}`);
    if (file.name.toLowerCase().endsWith('.epub')) {
      cover = await extractCoverFromFile(file, file.name);
      if (cover) log(`识别到内嵌封面（${(cover.bytes.byteLength / 1024).toFixed(0)}KB）`);
    }
    log(`元数据提取耗时 ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    log(`元数据提取失败（不影响上传）：${e.message}`);
  }

  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const initRes = await api('/api/upload/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename: file.name,
      size: file.size,
      mime: file.type || 'application/octet-stream',
      chunkSize: CHUNK_SIZE,
      sha256: fileSha256,
      meta,
    }),
  });
  const init = await initRes.json();
  if (!initRes.ok || !init.ok) throw new Error(init.error || '初始化上传失败');
  const uploadId = init.uploadId;
  log(`已初始化：${uploadId}，共 ${totalChunks} 块`);

  // 并发上传分块（保持顺序进度统计）
  let doneCount = 0;
  let uploadedBytes = 0;
  let lastSpeedTick = Date.now();
  const speedTimer = setInterval(() => {
    const now = Date.now();
    const secs = (now - lastSpeedTick) / 1000;
    if (secs <= 0) return;
    const mbps = uploadedBytes / 1024 / 1024 / secs;
    if (speedEl) {
      speedEl.textContent = `${mbps.toFixed(1)} MB/s`;
      speedEl.style.display = '';
    }
    uploadedBytes = 0;
    lastSpeedTick = now;
  }, 500);
  const uploadOne = async (i) => {
    const start = i * CHUNK_SIZE;
    const end = Math.min(file.size, start + CHUNK_SIZE);
    const blob = file.slice(start, end);
    const fd = new FormData();
    fd.append('uploadId', uploadId);
    fd.append('index', String(i));
    fd.append('file', blob, `${file.name}.part${String(i).padStart(3, '0')}`);

    const res = await api(`/api/upload/chunk`, { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(`分块 ${i + 1}/${totalChunks} 失败: ${data.error || res.status}`);
    }
    uploadedBytes += end - start;
    doneCount++;
    setProgress((doneCount / totalChunks) * 100);
    if (doneCount % 5 === 0 || doneCount === totalChunks) {
      log(`分块 ${doneCount}/${totalChunks} 已完成`);
    }
  };

  const worker = async () => {
    while (true) {
      const i = nextIndex++;
      if (i >= totalChunks) return;
      await uploadOne(i);
    }
  };
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, totalChunks) }, worker));
  clearInterval(speedTimer);

  const done = await api('/api/upload/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId, sha256: fileSha256, meta }),
  });
  const result = await done.json();
  if (!done.ok || !result.ok) throw new Error(result.error || '完成入库失败');
  if (result.bookId && cover) {
    let compressed = cover;
    try {
      compressed = await compressCover(cover.bytes, cover.mime);
      log(`封面压缩：${(cover.bytes.byteLength / 1024).toFixed(0)}KB → ${(compressed.byteLength / 1024).toFixed(0)}KB`);
    } catch (e) {
      log(`封面压缩失败，使用原图：${e.message}`);
    }
    const fd = new FormData();
    fd.append('file', new Blob([compressed], { type: 'image/webp' }), 'cover.webp');
    const coverRes = await api(`/api/books/${result.bookId}/cover`, { method: 'POST', body: fd });
    if (coverRes.ok) log('封面已保存');
    else log('封面上传失败（不影响入库）');
  }
  log('入库完成，可在“下载”页找到该书');
  return uploadId;
}

// 用 Canvas 把封面压缩为 WebP（最长边限制），大幅减小存储
async function compressCover(bytes, mime) {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('图片解码失败'));
      el.src = url;
    });
    const MAX = 500;
    const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    return await new Promise((resolve, reject) => {
      canvas.toBlob((b) => {
        if (!b) return reject(new Error('WebP 编码失败'));
        b.arrayBuffer().then((ab) => resolve(new Uint8Array(ab))).catch(reject);
      }, 'image/webp', 0.8);
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

let currentUpload = null;

startBtn.addEventListener('click', async () => {
  const file = fileEl.files[0];
  if (!file) {
    log('请先选择文件');
    return;
  }
  startBtn.disabled = true;
  abortBtn.disabled = false;
  try {
    currentUpload = { aborted: false };
    const controller = new AbortController();
    currentUpload.controller = controller;
    await uploadFile(file);
  } catch (e) {
    log(`错误: ${e.message}`);
  } finally {
    startBtn.disabled = false;
    abortBtn.disabled = true;
  }
});

abortBtn.addEventListener('click', () => {
  if (currentUpload?.controller) currentUpload.controller.abort();
  log('用户中止上传');
});

function setProgress(pct) {
  progressEl.hidden = false;
  progressEl.innerHTML = `<i style="width:${pct}%"></i>`;
  const wrap = document.getElementById('progress-wrap');
  if (wrap) wrap.hidden = false;
}
