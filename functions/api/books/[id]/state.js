import { json, err } from '../../../utils/http.js';
import { dbGet, dbRun, nowSec } from '../../../utils/db.js';
import { normalizeComment, normalizeFavorite, normalizeRating, normalizeStatus } from '../../../utils/books.js';

// 记录当前账号对这本书的评分与阅读状态（每人一份，互不覆盖）
export async function onRequestPut(context) {
  const { request, env, params } = context;
  const user = context.data.user;
  if (user.id === 'service') {
    return err('服务令牌没有个人书单，请用账号登录后再评分');
  }

  const book = await dbGet(env, 'SELECT id FROM books WHERE id = ?', params.id);
  if (!book) return err('书籍不存在', 404);

  const body = await request.json().catch(() => null);
  if (!body) return err('请求体必须是 JSON');

  const existing = await dbGet(
    env,
    'SELECT rating, status, is_favorite, comment FROM book_user_state WHERE book_id = ? AND user_id = ?',
    params.id,
    user.id
  );
  const rating = body.rating != null ? normalizeRating(body.rating) : (existing?.rating ?? 0);
  const status = body.status != null ? normalizeStatus(body.status) : (existing?.status ?? 'unread');
  const isFavorite = body.isFavorite != null
    ? normalizeFavorite(body.isFavorite)
    : (existing?.is_favorite ?? 0);
  const comment = body.comment != null ? normalizeComment(body.comment) : (existing?.comment ?? '');

  await dbRun(
    env,
    `INSERT INTO book_user_state (book_id, user_id, rating, status, is_favorite, comment, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(book_id, user_id)
     DO UPDATE SET rating = excluded.rating, status = excluded.status,
       is_favorite = excluded.is_favorite, comment = excluded.comment, updated_at = excluded.updated_at`,
    params.id,
    user.id,
    rating,
    status,
    isFavorite,
    comment,
    nowSec()
  );

  return json({ ok: true, rating, status, isFavorite: Boolean(isFavorite), comment });
}
