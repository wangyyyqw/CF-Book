import { json, err } from '../../utils/http.js';
import { dbGet, dbAll, dbRun, nowSec } from '../../utils/db.js';
import { classifyBook, cleanBookTitle } from '../../utils/ai-classification.js';

function cleanBase(name) {
  const base = String(name || '').replace(/\.[^.]+$/, '');
  return base || '未命名';
}

function ext(name) {
  const m = String(name || '').match(/\.([A-Za-z0-9]+)$/);
  return m ? m[1].toLowerCase() : '';
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const body = await request.json().catch(() => null);
  const uploadId = String(body?.uploadId || '');
  if (!uploadId) return err('缺少 uploadId');

  const upload = await dbGet(env, 'SELECT * FROM uploads WHERE upload_id = ?', uploadId);
  if (!upload) return err('上传任务不存在', 404);
  if (context.data.user.role !== 'admin' && upload.owner !== context.data.user.username) {
    return err('无权完成其他账号的上传任务', 403);
  }

  const chunks = await dbAll(env, 'SELECT * FROM chunks WHERE upload_id = ? ORDER BY idx', uploadId);
  if (chunks.length !== upload.total_chunks) return err('分块记录不完整');

  const failed = chunks.filter((c) => c.status === 'failed');
  if (failed.length) return err(`仍有 ${failed.length} 个分块上传失败，请重试失败分块`, 409);

  const missing = chunks.filter((c) => c.status !== 'uploaded');
  if (missing.length) return err(`还有 ${missing.length} 个分块未上传`, 409);

  const total = chunks.reduce((sum, c) => sum + c.size, 0);
  if (total !== upload.total_size) {
    return err(`分块总大小与文件不符：${total} != ${upload.total_size}`, 409);
  }

  const sha256 = String(body.sha256 || '');
  await dbRun(
    env,
    `UPDATE uploads SET status = 'completed', sha256 = ?, updated_at = ? WHERE upload_id = ?`,
    sha256,
    nowSec(),
    uploadId
  );

  // 上传完成后自动建立书籍档案
  const existing = await dbGet(env, 'SELECT id FROM books WHERE upload_id = ?', uploadId);
  let bookId;
  if (!existing) {
    const now = nowSec();
    bookId = crypto.randomUUID();
    const meta = body.meta || {};
    const clean = (v) => String(v || '').trim();
    await dbRun(
      env,
      `INSERT INTO books
         (id, upload_id, title, author, description, cover, format, isbn, publisher, language,
          file_name, file_size, sha256, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      bookId,
      uploadId,
      clean(meta.title) || cleanBase(upload.filename),
      clean(meta.author),
      clean(meta.description),
      clean(meta.format) || ext(upload.filename),
      clean(meta.isbn),
      clean(meta.publisher),
      clean(meta.language),
      upload.filename,
      upload.total_size,
      upload.sha256 || sha256,
      context.data.user.username,
      now,
      now
    );
  } else {
    bookId = existing.id;
  }

  // 不阻塞上传响应；生产 Pages 会在后台先清洗书名，再基于清洗后的书名做联网检索与 AI 分类。
  if (!existing && env.AI && typeof context.waitUntil === 'function') {
    context.waitUntil((async () => {
      await cleanBookTitle(env, bookId).catch(() => {});
      await classifyBook(env, bookId).catch(() => {});
    })());
  }

  return json({
    ok: true,
    uploadId,
    status: 'completed',
    filename: upload.filename,
    size: upload.total_size,
    chunkCount: upload.total_chunks,
    bookCreated: true,
    bookId,
  });
}
