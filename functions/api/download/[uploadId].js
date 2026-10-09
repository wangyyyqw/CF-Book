import { json, err } from '../../utils/http.js';
import { dbGet, dbAll } from '../../utils/db.js';

export async function onRequestGet(context) {
  const { env, params } = context;
  const uploadId = String(params.uploadId || '');
  if (!uploadId) return err('缺少 uploadId');

  const upload = await dbGet(env, 'SELECT * FROM uploads WHERE upload_id = ?', uploadId);
  if (!upload) return err('上传任务不存在', 404);
  if (upload.status !== 'completed') return err('该书籍尚未入库完成', 409);

  const chunks = await dbAll(env, 'SELECT * FROM chunks WHERE upload_id = ? ORDER BY idx', uploadId);
  return json({
    ok: true,
    uploadId,
    filename: upload.filename,
    size: upload.total_size,
    sha256: upload.sha256,
    chunks: chunks.map((c) => ({ index: c.idx, size: c.size, sha256: c.sha256 })),
  });
}
