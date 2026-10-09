import { json, err } from '../../../utils/http.js';
import { dbGet, dbRun, nowSec } from '../../../utils/db.js';

const MAX_COVER = 8 * 1024 * 1024;

export async function onRequestPost(context) {
  const { request, env, params } = context;
  const user = context.data.user;
  const book = await dbGet(env, 'SELECT * FROM books WHERE id = ?', params.id);
  if (!book) return err('书籍不存在', 404);
  if (user.role !== 'admin' && book.created_by !== user.username) {
    return err('只能修改自己上传书籍的封面', 403);
  }

  const form = await request.formData().catch(() => null);
  if (!form) return err('请求体必须是 multipart/form-data');
  const file = form.get('file');
  if (!file) return err('缺少 file 字段');
  if (file.size > MAX_COVER) return err('封面不能超过 8MB');

  const bytes = await file.arrayBuffer();
  if (bytes.byteLength === 0) return err('封面内容为空');

  // 按实际 MIME 决定存储类型，避免 WebP/PNG 被误标为 JPEG 导致前端解码失败
  const mime = String(file.type || '').split(';')[0].trim().toLowerCase();
  const extMap = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
  const ext = extMap[mime] || 'jpg';
  const contentType = mime || 'image/jpeg';

  const key = `covers/${params.id}.${ext}`;
  await env.COVERS.put(key, bytes, {
    httpMetadata: { contentType },
  });

  const coverPath = `/api/covers/${params.id}.${ext}`;
  await dbRun(env, 'UPDATE books SET cover = ?, updated_at = ? WHERE id = ?', coverPath, nowSec(), params.id);

  return json({ ok: true, cover: coverPath, key });
}
