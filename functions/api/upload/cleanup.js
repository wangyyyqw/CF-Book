import { json } from '../../utils/http.js';
import { dbAll, dbRun, nowSec } from '../../utils/db.js';
import { requireAdmin } from '../../utils/auth.js';

const STALE_DAYS = 30;

// 清理长期没有活动的上传任务：没有任何已上传分块的直接删除，
// 已经传了一部分但仍然停滞的改为 aborted，保留分块供之后续传。
export async function onRequestPost(context) {
  const denied = requireAdmin(context);
  if (denied) return denied;

  const { env, request } = context;
  const body = await request.json().catch(() => ({}));
  const requested = Number(body?.days);
  const days = requested > 0 ? requested : STALE_DAYS;
  const cutoff = nowSec() - days * 86400;

  const empty = await dbAll(
    env,
    `SELECT upload_id FROM uploads u
      WHERE u.status = 'active' AND u.updated_at < ?
        AND NOT EXISTS (SELECT 1 FROM chunks c WHERE c.upload_id = u.upload_id AND c.status = 'uploaded')`,
    cutoff
  );
  for (const row of empty) {
    await dbRun(env, 'DELETE FROM chunks WHERE upload_id = ?', row.upload_id);
    await dbRun(env, 'DELETE FROM uploads WHERE upload_id = ?', row.upload_id);
  }

  const partial = await dbAll(
    env,
    `SELECT upload_id FROM uploads u
      WHERE u.status = 'active' AND u.updated_at < ?
        AND EXISTS (SELECT 1 FROM chunks c WHERE c.upload_id = u.upload_id AND c.status = 'uploaded')`,
    cutoff
  );
  for (const row of partial) {
    await dbRun(env, "UPDATE uploads SET status = 'aborted' WHERE upload_id = ?", row.upload_id);
  }

  return json({ ok: true, days, deleted: empty.length, aborted: partial.length });
}
