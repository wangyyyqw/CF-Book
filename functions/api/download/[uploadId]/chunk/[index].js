import { json, err } from '../../../../utils/http.js';
import { dbGet } from '../../../../utils/db.js';
import { sha256Hex } from '../../../../utils/hash.js';
import { tgDownloadChunk } from '../../../../utils/tg.js';

export async function onRequestGet(context) {
  const { env, params } = context;
  const uploadId = String(params.uploadId || '');
  const index = Number(params.index);
  if (!uploadId || !Number.isInteger(index) || index < 0) return err('参数错误');

  const upload = await dbGet(env, 'SELECT * FROM uploads WHERE upload_id = ?', uploadId);
  if (!upload) return err('上传任务不存在', 404);
  if (upload.status !== 'completed') return err('该书籍尚未入库完成', 409);

  const chunk = await dbGet(
    env,
    'SELECT * FROM chunks WHERE upload_id = ? AND idx = ?',
    uploadId,
    index
  );
  if (!chunk || !chunk.tg_file_id) return err('分块不存在', 404);

  const tgRes = await tgDownloadChunk(env, chunk.tg_file_id);
  const bytes = await tgRes.arrayBuffer();
  if (bytes.byteLength !== chunk.size) {
    return err(`分块大小校验失败：期望 ${chunk.size}，实际 ${bytes.byteLength}`, 502);
  }

  const sha256 = await sha256Hex(bytes);
  if (sha256 !== chunk.sha256) {
    return err(`分块哈希校验失败：期望 ${chunk.sha256}，实际 ${sha256}`, 502);
  }

  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(bytes.byteLength),
      'Cache-Control': 'private, no-store',
      'X-Checksum-Sha256': sha256,
    },
  });
}
