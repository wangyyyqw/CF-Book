import { json, err } from '../../utils/http.js';
import { dbGet, dbAll, dbRun, nowSec } from '../../utils/db.js';
import { requireAdmin } from '../../utils/auth.js';
import { tgDeleteMessage } from '../../utils/tg.js';
import { standardTagDetails, validateTagIdList, replaceStandardTags } from '../../utils/standard-tags.js';

export async function onRequestGet(context) {
  const { env, params } = context;
  const me = context.data.user;
  const book = await dbGet(env, 'SELECT * FROM books WHERE id = ?', params.id);
  if (!book) return err('书籍不存在', 404);
  const tags = await standardTagDetails(env, params.id);
  book.tag_details = tags;
  book.tags = tags.map((tag) => tag.name);
  book.tag_categories = tags.reduce((groups, tag) => {
    (groups[tag.dimension] ||= []).push(tag.name);
    return groups;
  }, {});

  // 每个账号各自的评分与状态，所有人都能看见
  const states = await dbAll(
    env,
    `SELECT s.user_id, s.rating, s.status, s.is_favorite, s.updated_at, u.username, u.display_name
       FROM book_user_state s JOIN users u ON u.id = s.user_id
      WHERE s.book_id = ? ORDER BY s.updated_at DESC`,
    params.id
  );
  const mine = states.find((s) => s.user_id === me.id);
  const scored = states.filter((s) => s.rating > 0);
  book.my_rating = mine ? mine.rating : 0;
  book.my_status = mine ? mine.status : 'unread';
  book.my_favorite = mine ? Boolean(mine.is_favorite) : false;
  book.ratings = states;
  book.rating_count = scored.length;
  book.rating_avg = scored.length
    ? Math.round((scored.reduce((sum, s) => sum + s.rating, 0) / scored.length) * 10) / 10
    : 0;
  return json({ ok: true, book });
}

export async function onRequestPost(context) {
  const denied = requireAdmin(context);
  if (denied) return denied;

  const { request, env } = context;
  const body = await request.json().catch(() => null);
  if (!body) return err('请求体必须是 JSON');

  const now = nowSec();
  const id = crypto.randomUUID();
  const uploadId = String(body.uploadId || '');
  const upload = uploadId
    ? await dbGet(env, 'SELECT * FROM uploads WHERE upload_id = ?', uploadId)
    : null;
  if (uploadId && !upload) return err('关联的上传任务不存在', 404);

  const fields = {
    title: String(body.title || '').trim() || (upload ? cleanBase(upload.filename) : '未命名'),
    author: String(body.author || '').trim(),
    description: String(body.description || '').trim(),
    cover: String(body.cover || '').trim(),
    format: String(body.format || '').trim() || ext(upload ? upload.filename : ''),
    isbn: String(body.isbn || '').trim(),
    publisher: String(body.publisher || '').trim(),
    language: String(body.language || '').trim(),
    file_name: upload ? upload.filename : String(body.file_name || ''),
    file_size: upload ? upload.total_size : Number(body.file_size) || 0,
    sha256: upload ? upload.sha256 : String(body.sha256 || ''),
  };

  let tagIds = null;
  if (body.tagIds != null) {
    const validated = await validateTagIdList(env, body.tagIds);
    if (validated.error) return err(validated.error);
    tagIds = validated.tagIds;
  }

  await dbRun(
    env,
    `INSERT INTO books
       (id, upload_id, title, author, description, cover, format, isbn, publisher, language,
        file_name, file_size, sha256, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    uploadId || null,
    fields.title,
    fields.author,
    fields.description,
    fields.cover,
    fields.format,
    fields.isbn,
    fields.publisher,
    fields.language,
    fields.file_name,
    fields.file_size,
    fields.sha256,
    context.data.user.username,
    now,
    now
  );

  if (tagIds) await replaceStandardTags(env, id, tagIds);
  return json({ ok: true, id, book: { id, ...fields } });
}

export async function onRequestPut(context) {
  const denied = requireAdmin(context);
  if (denied) return denied;

  const { request, env, params } = context;
  const body = await request.json().catch(() => null);
  if (!body) return err('请求体必须是 JSON');

  const existing = await dbGet(env, 'SELECT * FROM books WHERE id = ?', params.id);
  if (!existing) return err('书籍不存在', 404);

  const validatedTags = body.tagIds != null ? await validateTagIdList(env, body.tagIds) : null;
  if (validatedTags?.error) return err(validatedTags.error);

  const upd = {
    title: String(body.title ?? existing.title).trim(),
    author: String(body.author ?? existing.author).trim(),
    description: String(body.description ?? existing.description).trim(),
    cover: String(body.cover ?? existing.cover).trim(),
    format: String(body.format ?? existing.format).trim(),
    isbn: String(body.isbn ?? existing.isbn).trim(),
    publisher: String(body.publisher ?? existing.publisher).trim(),
    language: String(body.language ?? existing.language).trim(),
  };

  await dbRun(
    env,
    `UPDATE books SET title=?, author=?, description=?, cover=?, format=?, isbn=?, publisher=?,
       language=?, updated_at=? WHERE id=?`,
    upd.title,
    upd.author,
    upd.description,
    upd.cover,
    upd.format,
    upd.isbn,
    upd.publisher,
    upd.language,
    nowSec(),
    params.id
  );

  if (validatedTags) await replaceStandardTags(env, params.id, validatedTags.tagIds);
  return json({ ok: true });
}

export async function onRequestDelete(context) {
  const denied = requireAdmin(context);
  if (denied) return denied;

  const { env, params } = context;
  const book = await dbGet(env, 'SELECT * FROM books WHERE id = ?', params.id);
  if (!book) return err('书籍不存在', 404);

  // 由轻到重：先删派生封面，再删频道里的原文件，最后删 D1 记录。
  // 任何一步失败都中止，此时数据库记录还在，重试即可收敛（已删的消息重删返回 not found）。
  if (book.cover.startsWith('/api/covers/')) {
    await env.COVERS.delete(`covers/${book.cover.slice('/api/covers/'.length)}`);
  }

  const chunks = await dbAll(
    env,
    'SELECT idx, tg_message_id, tg_chat_id FROM chunks WHERE upload_id = ? AND tg_message_id IS NOT NULL',
    book.upload_id
  );
  for (const chunk of chunks) {
    try {
      await tgDeleteMessage(env, chunk.tg_chat_id || env.TG_CHAT_ID, chunk.tg_message_id);
    } catch (e) {
      return err(`删除 Telegram 分块失败（第 ${chunk.idx + 1} 块）：${e.message}`, 502);
    }
  }

  if (book.upload_id) {
    await dbRun(env, 'DELETE FROM chunks WHERE upload_id = ?', book.upload_id);
    await dbRun(env, 'DELETE FROM uploads WHERE upload_id = ?', book.upload_id);
  }
  await dbRun(env, 'DELETE FROM book_user_state WHERE book_id = ?', params.id);
  await dbRun(env, 'DELETE FROM book_tags WHERE book_id = ?', params.id);
  await dbRun(env, 'DELETE FROM book_standard_tags WHERE book_id = ?', params.id);
  await dbRun(env, 'DELETE FROM books WHERE id = ?', params.id);
  return json({ ok: true });
}

function cleanBase(name) {
  const base = name.replace(/\.[^.]+$/, '');
  return base || '未命名';
}

function ext(name) {
  const m = name.match(/\.([A-Za-z0-9]+)$/);
  return m ? m[1].toLowerCase() : '';
}
