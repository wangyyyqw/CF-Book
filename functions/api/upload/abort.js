import { json, err } from '../../utils/http.js';
import { dbGet, dbRun, nowSec } from '../../utils/db.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const body = await request.json().catch(() => null);
  const uploadId = String(body?.uploadId || '');
  if (!uploadId) return err('缺少 uploadId');

  const upload = await dbGet(env, 'SELECT * FROM uploads WHERE upload_id = ?', uploadId);
  if (!upload) return err('上传任务不存在', 404);
  if (context.data.user.role !== 'admin' && upload.owner !== context.data.user.username) {
    return err('无权中止其他账号的上传任务', 403);
  }

  await dbRun(env, "UPDATE uploads SET status = 'aborted', updated_at = ? WHERE upload_id = ?", nowSec(), uploadId);
  return json({ ok: true, uploadId, status: 'aborted' });
}
