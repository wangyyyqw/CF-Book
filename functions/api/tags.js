import { json } from '../utils/http.js';
import { dbAll } from '../utils/db.js';

export async function onRequestGet(context) {
  const { env } = context;
  const tags = await dbAll(
    env,
    'SELECT t.name, COUNT(bt.book_id) AS count FROM tags t LEFT JOIN book_tags bt ON bt.tag_id = t.id GROUP BY t.id ORDER BY count DESC, t.name'
  );
  return json({ ok: true, tags });
}
