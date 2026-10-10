import { json, err } from '../../../utils/http.js';
import { dbGet, dbRun, nowSec } from '../../../utils/db.js';
import { canEditBooks } from '../../../utils/shelves.js';

// 一次性增删书架成员，只处理确实存在的书，忽略重复添加
export async function onRequestPut(context) {
  const { request, env, params } = context;
  const user = context.data.user;
  const shelf = await dbGet(env, 'SELECT * FROM shelves WHERE id = ?', params.id);
  if (!shelf) return err('书架不存在', 404);
  if (!canEditBooks(user, shelf)) return err('没有权限整理这个书架', 403);

  const body = await request.json().catch(() => null);
  if (!body) return err('请求体必须是 JSON');
  const add = Array.isArray(body.add) ? [...new Set(body.add.map(String).filter(Boolean))] : [];
  const remove = Array.isArray(body.remove) ? [...new Set(body.remove.map(String).filter(Boolean))] : [];
  const now = nowSec();

  let added = 0;
  for (const bookId of add) {
    const book = await dbGet(env, 'SELECT id FROM books WHERE id = ?', bookId);
    if (!book) continue;
    const result = await dbRun(
      env,
      `INSERT INTO shelf_books (shelf_id, book_id, added_by, added_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(shelf_id, book_id) DO NOTHING`,
      shelf.id,
      bookId,
      user.username,
      now
    );
    if (result?.meta?.changes) added += 1;
  }

  let removed = 0;
  for (const bookId of remove) {
    const result = await dbRun(env, 'DELETE FROM shelf_books WHERE shelf_id = ? AND book_id = ?', shelf.id, bookId);
    if (result?.meta?.changes) removed += 1;
  }

  await dbRun(env, 'UPDATE shelves SET updated_at = ? WHERE id = ?', now, shelf.id);
  const count = await dbGet(env, 'SELECT COUNT(*) AS n FROM shelf_books WHERE shelf_id = ?', shelf.id);
  return json({ ok: true, added, removed, book_count: Number(count.n) || 0 });
}
