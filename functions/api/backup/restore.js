import { json, err } from '../../utils/http.js';
import { requireAdmin } from '../../utils/auth.js';
import { openBackup, restoreBackup, validateBackup } from '../../utils/backup.js';

// 恢复只写 D1：不删除、不覆盖 Telegram 里的分块，也不动 R2 封面。
export async function onRequestPost(context) {
  const denied = requireAdmin(context);
  if (denied) return denied;

  const { env, request } = context;
  const body = await request.json().catch(() => null);
  if (!body) return err('请求体必须是 JSON');

  const mode = body.mode === 'merge' ? 'merge' : 'replace';
  let backup;
  try {
    backup = await openBackup(env, body.backup);
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error));
  }

  const invalid = validateBackup(backup);
  if (invalid) return err(invalid);

  const result = await restoreBackup(env, backup, { mode });
  return json({ ok: true, ...result });
}
