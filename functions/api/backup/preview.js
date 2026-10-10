import { json, err } from '../../utils/http.js';
import { requireAdmin } from '../../utils/auth.js';
import { openBackup, previewBackup, validateBackup } from '../../utils/backup.js';

// 恢复前预览：只读统计备份内与当前库的条数，不做任何写入。
export async function onRequestPost(context) {
  const denied = requireAdmin(context);
  if (denied) return denied;

  const { env, request } = context;
  const body = await request.json().catch(() => null);
  if (!body) return err('请求体必须是 JSON');

  let backup;
  try {
    backup = await openBackup(env, body.backup);
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error));
  }

  const invalid = validateBackup(backup);
  if (invalid) return err(invalid);

  const summary = await previewBackup(env, backup);
  const total = Object.values(summary).reduce((sum, item) => sum + item.incoming, 0);
  return json({ ok: true, createdAt: backup.createdAt, encrypted: Boolean(body.backup?.encrypted), total, summary });
}
