import { api } from '/api.js';
import { formatBytes } from '/format.js';
import { openDownloadSink, runDownload } from '/download-stream.js';

async function fetchMeta(uploadId, signal) {
  const res = await api(`/api/download/${encodeURIComponent(uploadId)}`, { signal });
  const meta = await res.json().catch(() => ({}));
  if (!res.ok || !meta.ok) throw new Error(meta.error || `获取文件信息失败（${res.status}）`);
  return meta;
}

// 逐块下载并校验 SHA-256；校验通过才交给写入目标
function makeChunkFetcher(uploadId, signal) {
  return async (chunk) => {
    const res = await api(`/api/download/${encodeURIComponent(uploadId)}/chunk/${chunk.index}`, { signal });
    if (!res.ok) throw new Error(`分块 ${chunk.index + 1} 下载失败：${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    if (hex !== chunk.sha256) throw new Error(`分块 ${chunk.index + 1} 哈希校验失败`);
    return bytes;
  };
}

const SINK_MESSAGE = {
  'file-system-access': '正在写入你选择的文件…',
  opfs: '正在写入浏览器临时存储（OPFS），完成后自动保存…',
  blob: '当前浏览器不支持流式写入，改为内存合并（大文件可能卡顿）…',
};

export async function downloadBook(uploadId, filename, {
  onProgress,
  onMessage,
  signal,
  preferFilePicker = false,
  windowSize,
  env = globalThis,
} = {}) {
  const report = onMessage || (() => {});
  const progress = onProgress || (() => {});
  // 先打开写入目标：showSaveFilePicker 需要用户手势，放到网络请求之后会被浏览器拒绝
  const sink = await openDownloadSink(filename || 'download', { preferFilePicker, env });
  report(SINK_MESSAGE[sink.kind] || '开始下载…');

  try {
    const meta = await fetchMeta(uploadId, signal);
    const result = await runDownload({
      chunks: meta.chunks,
      sink,
      fetchChunk: makeChunkFetcher(uploadId, signal),
      signal,
      windowSize,
      onProgress: (state) => progress({
        ...state,
        percent: state.total ? (state.done / state.total) * 100 : 100,
      }),
    });
    await sink.close();
    report(`下载完成：${result.total} 块，共 ${formatBytes(result.downloadedBytes)}`);
    return { ...result, sinkKind: sink.kind };
  } catch (error) {
    await sink.abort();
    throw error;
  }
}
