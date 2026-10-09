import { json, err } from '../../../../utils/http.js';
import { dbGet } from '../../../../utils/db.js';

export async function onRequestGet(context) {
  const { env, params } = context;
  const uploadId = String(params.uploadId || '');
  const index = Number(params.index);
  if (!uploadId || !Number.isInteger(index) || index < 0) return err('参数错误');

  const chunk = await dbGet(
    env,
    'SELECT * FROM chunks WHERE upload_id = ? AND idx = ?',
    uploadId,
    index
  );
  if (!chunk) return err('分块不存在', 404);

  return json({
    ok: true,
    uploadId,
    index,
    status: chunk.status,
    sha256: chunk.sha256,
    size: chunk.size,
    tgFileId: chunk.tg_file_id,
  });
}
