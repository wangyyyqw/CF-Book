import { dbGet, dbRun } from './db.js';
import { tagCategory } from './tag-catalog.js';

// 全量替换某本书的标签（标签本身是共享的）
export async function replaceTags(env, bookId, tags) {
  await dbRun(env, 'DELETE FROM book_tags WHERE book_id = ?', bookId);
  for (const name of tags) {
    await dbRun(env, 'INSERT OR IGNORE INTO tags (name, category) VALUES (?, ?)', name, tagCategory(name));
    const row = await dbGet(env, 'SELECT id FROM tags WHERE name = ?', name);
    if (row) {
      await dbRun(env, 'INSERT OR IGNORE INTO book_tags (book_id, tag_id) VALUES (?, ?)', bookId, row.id);
    }
  }
}
