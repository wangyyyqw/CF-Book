import { json, err } from '../../utils/http.js';
import { dbRun, nowSec } from '../../utils/db.js';

const MAX_FILE_SIZE = 4 * 1024 * 1024 * 1024; // 4 GiB（原型上限）
const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024; // 8 MiB，低于 Telegram 20 MiB 下载限制

export async function onRequestPost(context) {
  const { request, env } = context;
  const body = await request.json().catch(() => null);
  if (!body) return err('请求体必须是 JSON');

  const filename = String(body.filename || '').trim();
  const size = Number(body.size);
  const mime = String(body.mime || 'application/octet-stream');
  const chunkSize = Number(body.chunkSize) || DEFAULT_CHUNK_SIZE;
  const sha256 = String(body.sha256 || '').toLowerCase();

  if (!filename || !size || size <= 0) return err('缺少 filename 或 size');
  if (size > MAX_FILE_SIZE) return err('文件超过原型上限 4 GiB');
  if (chunkSize < 1 * 1024 * 1024 || chunkSize > 16 * 1024 * 1024) {
    return err('chunkSize 必须在 1–16 MiB 之间');
  }

  const totalChunks = Math.ceil(size / chunkSize);
  const uploadId = crypto.randomUUID();
  const now = nowSec();

  await dbRun(
    env,
    `INSERT INTO uploads
       (upload_id, filename, mime, total_size, chunk_size, total_chunks, sha256, status, owner, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    uploadId,
    filename,
    mime,
    size,
    chunkSize,
    totalChunks,
    sha256,
    context.data.user.username,
    now,
    now
  );

  const stmts = [];
  for (let i = 0; i < totalChunks; i++) {
    const chunkSizeNow = i === totalChunks - 1 ? size - i * chunkSize : chunkSize;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO chunks (upload_id, idx, size, status, updated_at) VALUES (?, ?, ?, 'pending', ?)`
      ).bind(uploadId, i, chunkSizeNow, now)
    );
  }
  await env.DB.batch(stmts);

  return json({ ok: true, uploadId, chunkSize, totalChunks, filename, size, mime });
}
