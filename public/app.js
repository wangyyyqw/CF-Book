import { extractFileMetadata, extractCoverFromFile } from '/metadata.js';
import { api } from '/api.js';
import { runUploadQueue } from '/upload-queue.js';
import { readJsonResponse, responseError, wait } from '/upload-http.js';

const CHUNK_SIZE = 16 * 1024 * 1024; // 16MiB，低于 Telegram 20MiB 下载限制
const UPLOAD_CONCURRENCY = 5; // 并发上传分块数（Telegram 不排斥并发，实测并行更快）

const $ = (id) => document.getElementById(id);
const fileEl = $('file');
const startBtn = $('start');
const abortBtn = $('abort');
const progressEl = $('progress');
const speedEl = $('speed');
const logEl = $('log');
const fileSummaryEl = $('file-summary');
const queueEl = $('file-queue');
const CHUNK_RETRIES = 3;

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

async function uploadFile(file, { signal, onLog = log } = {}) {
  const report = (text) => onLog(`[${file.name}] ${text}`);
  const checkAborted = () => {
    if (signal?.aborted) throw new DOMException('上传已中止', 'AbortError');
  };
  if (!crypto.subtle) {
    throw new Error('当前环境不支持 crypto.subtle，无法计算哈希');
  }
  report('计算文件 SHA-256（大文件需要一点时间）…');
  let fileSha256 = '';
  if (file.size > 1024 * 1024 * 1024) {
    report('超大文件（>1GB）跳过整书哈希计算，分块哈希已保证数据完整性');
  } else {
    fileSha256 = await sha256OfFile(file);
    report(`文件 SHA-256: ${fileSha256.slice(0, 16)}…`);
  }
  checkAborted();

  // 尝试从文件内部提取元数据（EPUB/PDF/MOBI）
  let meta = { title: '', author: '', format: '', publisher: '', language: '', isbn: '', description: '', date: '' };
  let cover = null;
  try {
    const t0 = performance.now();
    meta = await extractFileMetadata(file, file.name);
    if (meta.title) report(`识别书名：${meta.title}`);
    if (meta.author) report(`识别作者：${meta.author}`);
    if (meta.isbn) report(`识别 ISBN：${meta.isbn}`);
    if (file.name.toLowerCase().endsWith('.epub')) {
      cover = await extractCoverFromFile(file, file.name);
      if (cover?.bytes) report(`识别到内嵌封面（${(cover.bytes.byteLength / 1024).toFixed(0)}KB）`);
      else if (cover?.url) report('识别到外链封面，入库时由服务端抓取');
    }
    report(`元数据提取耗时 ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    report(`元数据提取失败（不影响上传）：${e.message}`);
  }
  checkAborted();

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
    signal,
  });
  const init = await readJsonResponse(initRes, '初始化上传');
  if (!initRes.ok || !init.ok) throw responseError(initRes, init, '初始化上传');
  const uploadId = init.uploadId;
  const chunkSize = Number(init.chunkSize) || CHUNK_SIZE;
  const totalChunks = Number(init.totalChunks) || Math.ceil(file.size / chunkSize);
  const uploadedChunks = new Set((init.uploadedChunks || []).map(Number));
  if (init.resumed) {
    report(`继续未完成任务：已完成 ${uploadedChunks.size}/${totalChunks} 块`);
  }
  report(`已初始化：${uploadId}，共 ${totalChunks} 块`);
  setProgress((uploadedChunks.size / totalChunks) * 100);

  // 并发上传分块（保持顺序进度统计）
  let doneCount = uploadedChunks.size;
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
    if (uploadedChunks.has(i)) return;
    const start = i * chunkSize;
    const end = Math.min(file.size, start + chunkSize);
    const blob = file.slice(start, end);

    let lastError;
    for (let attempt = 1; attempt <= CHUNK_RETRIES; attempt++) {
      checkAborted();
      try {
        const fd = new FormData();
        fd.append('uploadId', uploadId);
        fd.append('index', String(i));
        fd.append('file', blob, `${file.name}.part${String(i).padStart(3, '0')}`);
        const res = await api(`/api/upload/chunk`, { method: 'POST', body: fd, signal });
        const data = await readJsonResponse(res, `分块 ${i + 1}/${totalChunks}`);
        if (!res.ok || !data.ok) throw responseError(res, data, `分块 ${i + 1}/${totalChunks}`);
        uploadedBytes += end - start;
        doneCount++;
        setProgress((doneCount / totalChunks) * 100);
        if (doneCount % 5 === 0 || doneCount === totalChunks) {
          report(`分块 ${doneCount}/${totalChunks} 已完成`);
        }
        return;
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        lastError = error;
        if (!(error instanceof Error) || error.name === 'TypeError') error.retryable = true;
        if (!error.retryable || attempt === CHUNK_RETRIES) throw error;
        report(`分块 ${i + 1}/${totalChunks} 第 ${attempt} 次失败，${attempt + 1} 秒后重试…`);
        await wait(attempt * 1000);
      }
    }
    throw lastError;
  };

  const worker = async () => {
    while (true) {
      const i = nextIndex++;
      if (i >= totalChunks) return;
      await uploadOne(i);
    }
  };
  let nextIndex = 0;
  try {
    await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, totalChunks) }, worker));
  } finally {
    clearInterval(speedTimer);
  }

  const done = await api('/api/upload/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId, sha256: fileSha256, meta }),
    signal,
  });
  const result = await readJsonResponse(done, '完成入库');
  if (!done.ok || !result.ok) throw responseError(done, result, '完成入库');
  if (result.bookId && cover) {
    if (cover.url) {
      const fd = new FormData();
      fd.append('sourceUrl', cover.url);
      const coverRes = await api(`/api/books/${result.bookId}/cover`, { method: 'POST', body: fd, signal });
      if (coverRes.ok) report('外链封面已抓取并保存');
      else report('外链封面抓取失败（不影响入库）');
      report('入库完成，可在“下载”页找到该书');
      return uploadId;
    }
    let compressed = cover;
    try {
      compressed = await compressCover(cover.bytes, cover.mime);
      report(`封面压缩：${(cover.bytes.byteLength / 1024).toFixed(0)}KB → ${(compressed.byteLength / 1024).toFixed(0)}KB`);
    } catch (e) {
      report(`封面压缩失败，使用原图：${e.message}`);
    }
    const fd = new FormData();
    fd.append('file', new Blob([compressed], { type: 'image/webp' }), 'cover.webp');
    const coverRes = await api(`/api/books/${result.bookId}/cover`, { method: 'POST', body: fd, signal });
    if (coverRes.ok) report('封面已保存');
    else report('封面上传失败（不影响入库）');
  }
  report('入库完成，可在“下载”页找到该书');
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

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function renderQueue(files, statuses = new Map()) {
  queueEl.innerHTML = files.map((file) => {
    const status = statuses.get(file) || '等待上传';
    return `<li><span>${escapeHtml(file.name)}</span><strong>${escapeHtml(status)}</strong></li>`;
  }).join('');
}

fileEl.addEventListener('change', () => {
  const files = [...fileEl.files];
  fileSummaryEl.textContent = files.length
    ? `已选择 ${files.length} 本书`
    : '可一次选择多本书，系统会按顺序上传。';
  renderQueue(files);
});

startBtn.addEventListener('click', async () => {
  const files = [...fileEl.files];
  if (!files.length) {
    log('请先选择文件');
    return;
  }
  startBtn.disabled = true;
  abortBtn.disabled = false;
  try {
    const controller = new AbortController();
    currentUpload = { controller };
    const statuses = new Map(files.map((file) => [file, '等待上传']));
    renderQueue(files, statuses);
    const results = await runUploadQueue(files, (file) => uploadFile(file, {
      signal: controller.signal,
      onLog: log,
    }), {
      signal: controller.signal,
      onStart: (file) => {
        statuses.set(file, '上传中');
        setProgress(0);
        renderQueue(files, statuses);
      },
      onSuccess: (file) => { statuses.set(file, '已完成'); renderQueue(files, statuses); },
      onError: (file, error) => {
        const message = error instanceof Error ? error.message : String(error);
        statuses.set(file, `失败：${message}`);
        renderQueue(files, statuses);
      },
      onCancel: (file) => { statuses.set(file, '已中止'); renderQueue(files, statuses); },
    });
    const completed = results.filter((result) => result.status === 'completed').length;
    const failed = results.filter((result) => result.status === 'failed').length;
    const cancelled = results.filter((result) => result.status === 'cancelled').length;
    log(`批量上传结束：完成 ${completed} 本，失败 ${failed} 本，中止 ${cancelled} 本`);
  } catch (e) {
    log(`批量上传错误: ${e.message}`);
  } finally {
    startBtn.disabled = false;
    abortBtn.disabled = true;
    currentUpload = null;
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
