import { api } from '/api.js';

export async function downloadBook(uploadId, filename, { onProgress, onMessage } = {}) {
  const report = onMessage || (() => {});
  const progress = onProgress || (() => {});
  const metaRes = await api(`/api/download/${encodeURIComponent(uploadId)}`);
  const meta = await metaRes.json().catch(() => ({}));
  if (!metaRes.ok || !meta.ok) throw new Error(meta.error || `获取文件信息失败（${metaRes.status}）`);

  const parts = new Array(meta.chunks.length);
  let done = 0;
  let next = 0;
  const getChunk = async (chunk) => {
    const res = await api(`/api/download/${encodeURIComponent(uploadId)}/chunk/${chunk.index}`);
    if (!res.ok) throw new Error(`分块 ${chunk.index + 1} 下载失败：${res.status}`);
    const bytes = await res.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    if (hex !== chunk.sha256) throw new Error(`分块 ${chunk.index + 1} 哈希校验失败`);
    parts[chunk.index] = bytes;
    done += 1;
    progress(done / meta.chunks.length * 100);
    report(`已下载 ${done}/${meta.chunks.length} 块`);
  };
  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= meta.chunks.length) return;
      await getChunk(meta.chunks[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, meta.chunks.length) }, worker));

  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob(parts, { type: 'application/octet-stream' }));
  link.download = filename || meta.filename || 'download';
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  report('下载完成，浏览器已开始保存文件');
}
