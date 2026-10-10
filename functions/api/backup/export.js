import { err } from '../../utils/http.js';
import { requireAdmin } from '../../utils/auth.js';
import { encryptBackup, exportTables } from '../../utils/backup.js';

// 导出全部备份表；默认使用 BACKUP_KEY 加密，?encrypt=0 才输出明文。
export async function onRequestGet(context) {
  const denied = requireAdmin(context);
  if (denied) return denied;

  const { env, request } = context;
  const plain = new URL(request.url).searchParams.get('encrypt') === '0';
  const backup = await exportTables(env);

  let body;
  if (plain) {
    body = JSON.stringify(backup);
  } else {
    if (!env.BACKUP_KEY) {
      return err('未配置 BACKUP_KEY，无法生成加密备份；确实需要明文备份请显式加 encrypt=0', 500);
    }
    body = JSON.stringify(await encryptBackup(backup, env.BACKUP_KEY));
  }

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="cf-book-backup-${stamp}.json"`,
      'Cache-Control': 'no-store',
    },
  });
}
