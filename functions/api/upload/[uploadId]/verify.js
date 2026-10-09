import { json, err } from '../../../utils/http.js';
import { dbAll, dbGet, dbRun, nowSec } from '../../../utils/db.js';
import { tgFileInfo } from '../../../utils/tg.js';
import { mapLimit } from '../../../utils/concurrency.js';

const VERIFY_CONCURRENCY = 4;

// 逐块向 Telegram 查询文件是否仍存在、大小是否与 D1 记录一致。
// 只做只读校验，不改动任何分块或消息。
export async function onRequestPost(context) {
  const { env, params } = context;
  const uploadId = String(params.uploadId || '');
  const upload = await dbGet(env, 'SELECT * FROM uploads WHERE upload_id = ?', uploadId);
  if (!upload) return err('上传任务不存在', 404);
  if (context.data.user.role !== 'admin' && upload.owner !== context.data.user.username) {
    return err('无权校验其他账号的上传任务', 403);
  }

  const chunks = await dbAll(
    env,
    'SELECT idx, size, status, tg_file_id FROM chunks WHERE upload_id = ? ORDER BY idx',
    uploadId
  );

  const results = await mapLimit(chunks, VERIFY_CONCURRENCY, async (chunk) => {
    if (!chunk.tg_file_id) {
      return { index: chunk.idx, ok: false, reason: `分块状态为 ${chunk.status}，缺少 Telegram file_id` };
    }
    try {
      const info = await tgFileInfo(env, chunk.tg_file_id);
      if (info.fileSize && chunk.size && info.fileSize !== chunk.size) {
        return { index: chunk.idx, ok: false, reason: `大小不符：Telegram ${info.fileSize}，记录 ${chunk.size}` };
      }
      return { index: chunk.idx, ok: true };
    } catch (error) {
      return { index: chunk.idx, ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  });

  const bad = results.filter((result) => !result.ok);
  const summary = {
    total: chunks.length,
    ok: results.length - bad.length,
    bad: bad.length,
    badChunks: bad,
  };
  await dbRun(
    env,
    'UPDATE uploads SET verified_at = ?, verify_result = ? WHERE upload_id = ?',
    nowSec(),
    JSON.stringify(summary),
    uploadId
  );
  return json({ ok: true, uploadId, verified: summary });
}
