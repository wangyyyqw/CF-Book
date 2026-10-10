import { json } from '../../utils/http.js';
import { dbAll, dbGet } from '../../utils/db.js';
import { requireAdmin } from '../../utils/auth.js';

// 书库统计：按格式、语言、标准标签给出数量与占用大小。只读聚合，供管理页展示。
export async function onRequestGet(context) {
  const denied = requireAdmin(context);
  if (denied) return denied;
  const { env } = context;

  const totals = await dbGet(
    env,
    'SELECT COUNT(*) AS books, COALESCE(SUM(file_size), 0) AS size FROM books'
  );

  // 格式/语言为空字符串的书归入“未知”，由前端统一展示
  const formats = await dbAll(
    env,
    `SELECT format AS name, COUNT(*) AS count, COALESCE(SUM(file_size), 0) AS size
       FROM books GROUP BY format ORDER BY count DESC, format`
  );
  const languages = await dbAll(
    env,
    `SELECT language AS name, COUNT(*) AS count, COALESCE(SUM(file_size), 0) AS size
       FROM books GROUP BY language ORDER BY count DESC, language`
  );

  // 一本书最多 3 个标准标签，各标签的大小会重复计入，属预期的分维度口径
  const tags = await dbAll(
    env,
    `SELECT t.tag_id, t.name, t.dimension,
        COUNT(b.id) AS count, COALESCE(SUM(b.file_size), 0) AS size
       FROM book_standard_tags bt
       JOIN standard_tags t ON t.tag_id = bt.tag_id
       JOIN books b ON b.id = bt.book_id
      GROUP BY t.tag_id, t.name, t.dimension
      ORDER BY count DESC, t.name`
  );

  return json({
    ok: true,
    totals: { books: Number(totals.books) || 0, size: Number(totals.size) || 0 },
    formats: formats.map((row) => ({ name: row.name, count: Number(row.count), size: Number(row.size) })),
    languages: languages.map((row) => ({ name: row.name, count: Number(row.count), size: Number(row.size) })),
    tags: tags.map((row) => ({
      tag_id: row.tag_id,
      name: row.name,
      dimension: row.dimension,
      count: Number(row.count),
      size: Number(row.size),
    })),
  }, 200, { 'Cache-Control': 'private, max-age=30, stale-while-revalidate=60' });
}
