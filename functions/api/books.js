import { json, err } from '../utils/http.js';
import { dbAll, dbGet } from '../utils/db.js';
import { standardTagDetailsMany } from '../utils/standard-tags.js';
import { canViewShelf } from '../utils/shelves.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const user = context.data.user;
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  const tag = (url.searchParams.get('tag') || '').trim();
  const status = (url.searchParams.get('status') || '').trim();
  const shelfId = (url.searchParams.get('shelf') || '').trim();
  const recommended = url.searchParams.get('recommended') === '1';
  const compact = url.searchParams.get('compact') === '1';
  const countRequested = url.searchParams.get('count') !== '0';
  const requestedLimit = Number(url.searchParams.get('limit')) || (recommended ? 3 : 18);
  const limit = Math.min(requestedLimit, 100);
  const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);

  // 排序白名单：键映射到可排序的列或 SELECT 中已有的聚合别名，杜绝任意列注入
  const SORT_COLUMNS = {
    time: 'b.created_at',
    title: 'b.title',
    author: 'b.author',
    rating: 'rating_avg',
    size: 'b.file_size',
  };
  const sortKey = (url.searchParams.get('sort') || '').trim();
  const sortColumn = SORT_COLUMNS[sortKey] || SORT_COLUMNS.time;
  const sortDir = (url.searchParams.get('dir') || '').trim().toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  // my_* 是当前账号自己的评分/状态，rating_avg 是所有人打分的平均值
  const from = `
    FROM books b
    LEFT JOIN book_user_state mine ON mine.book_id = b.id AND mine.user_id = ?
  `;
  const where = [];
  const filters = [];
  if (q) {
    where.push('(b.title LIKE ? OR b.author LIKE ? OR b.description LIKE ?)');
    const like = `%${q}%`;
    filters.push(like, like, like);
  }
  if (tag) {
    if (tag === '__untagged__') {
      where.push('NOT EXISTS (SELECT 1 FROM book_standard_tags WHERE book_id = b.id)');
    } else {
      where.push('b.id IN (SELECT book_id FROM book_standard_tags WHERE tag_id = ?)');
      filters.push(tag);
    }
  }
  if (status) {
    where.push(status === 'favorite'
      ? 'COALESCE(mine.is_favorite, 0) = 1'
      : "COALESCE(mine.status, 'unread') = ?");
    if (status !== 'favorite') filters.push(status);
  }
  if (shelfId) {
    const shelf = await dbGet(env, 'SELECT id, scope, owner FROM shelves WHERE id = ?', shelfId);
    if (!shelf || !canViewShelf(user, shelf)) return err('书架不存在', 404);
    where.push('b.id IN (SELECT book_id FROM shelf_books WHERE shelf_id = ?)');
    filters.push(shelfId);
  }
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';

  const columns = compact
    ? 'b.id, b.title, b.author, b.cover'
    : 'b.*';
  const totalColumn = countRequested ? ', COUNT(*) OVER() AS matched_total' : '';
  const tagsColumn = compact ? '' :
    ', (SELECT group_concat(t.name, \',\') FROM book_standard_tags bt JOIN standard_tags t ON t.tag_id = bt.tag_id WHERE bt.book_id = b.id) AS tags';
  const books = await dbAll(
    env,
    `SELECT ${columns}${totalColumn}${tagsColumn},
      (SELECT ROUND(AVG(s.rating), 1) FROM book_user_state s WHERE s.book_id = b.id AND s.rating > 0) AS rating_avg,
      (SELECT COUNT(*) FROM book_user_state s WHERE s.book_id = b.id AND s.rating > 0) AS rating_count,
      ${compact
        ? `COALESCE(mine.status, 'unread') AS my_status,
      COALESCE(mine.is_favorite, 0) AS my_favorite`
        : `COALESCE(mine.rating, 0) AS my_rating,
      COALESCE(mine.status, 'unread') AS my_status,
      COALESCE(mine.is_favorite, 0) AS my_favorite`}
     ${from}${whereSql}
     ORDER BY ${recommended ? 'RANDOM()' : `${sortColumn} ${sortDir}, b.id DESC`}
     LIMIT ? OFFSET ?`,
    user.id,
    ...filters,
    limit,
    offset
  );

  let total = countRequested ? (books.length ? Number(books[0].matched_total) : (offset ?
    (await dbGet(env, `SELECT COUNT(*) AS n ${from}${whereSql}`, user.id, ...filters)).n : 0)) : null;
  const detailMap = await standardTagDetailsMany(env, books.map((book) => book.id), { namesOnly: compact });
  for (const book of books) {
    delete book.matched_total;
    const details = detailMap.get(book.id) || [];
    book.tag_details = details;
    if (!compact) {
      book.tag_categories = details.reduce((groups, tag) => {
        (groups[tag.dimension] ||= []).push(tag.name);
        return groups;
      }, {});
    }
  }
  return json({ ok: true, books, total, limit, offset, hasMore: total == null ? false : offset + books.length < total }, 200, {
    'Cache-Control': recommended
      ? 'private, no-store'
      : 'private, max-age=5, stale-while-revalidate=15',
  });
}
