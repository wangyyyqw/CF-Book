import { json, err } from '../../utils/http.js';
import { dbAll, dbGet, nowSec } from '../../utils/db.js';
import { requireAdmin } from '../../utils/auth.js';
import { cleanBookTitle, dailyLimit, usedAiNeuronsToday } from '../../utils/ai-classification.js';

export async function onRequestGet(context) {
  const denied = requireAdmin(context);
  if (denied) return denied;
  const row = await dbGet(
    context.env,
    `SELECT COUNT(*) AS total,
       COALESCE(SUM(CASE WHEN title_cleaned_at = 0 THEN 1 ELSE 0 END), 0) AS pending
     FROM books`
  );
  return json({
    ok: true,
    total: Number(row?.total || 0),
    pending: Number(row?.pending || 0),
  });
}

export async function onRequestPost(context) {
  const denied = requireAdmin(context);
  if (denied) return denied;
  const { env, request } = context;
  const body = await request.json().catch(() => ({}));
  const limit = Math.min(Math.max(Number(body.limit) || 10, 1), 50);
  const offset = Math.max(Number(body.offset) || 0, 0);
  const force = body.force === true;
  // 本轮已尝试但失败的书；重跑时跳过，避免对确定性失败反复消耗额度。
  const exclude = Array.isArray(body.exclude)
    ? body.exclude.filter((id) => typeof id === 'string').slice(0, 200)
    : [];
  const start = Math.floor(Date.now() / 86400000) * 86400;
  if (await usedAiNeuronsToday(env, start) >= dailyLimit(env)) return err('今日 AI 额度已用尽', 429);

  const excludeClause = exclude.length ? ` AND id NOT IN (${exclude.map(() => '?').join(',')})` : '';
  const books = await dbAll(
    env,
    `SELECT id FROM books
     WHERE (?=1 OR title_cleaned_at = 0)${excludeClause}
     ORDER BY created_at ASC LIMIT ? OFFSET ?`,
    force ? 1 : 0,
    ...exclude,
    limit,
    offset
  );
  const results = [];
  for (const book of books) {
    if (await usedAiNeuronsToday(env, start) >= dailyLimit(env)) break;
    try {
      const result = await cleanBookTitle(env, book.id);
      results.push({ bookId: book.id, title: result.title });
    } catch (error) {
      results.push({ bookId: book.id, error: error.message });
    }
  }
  const cleaned = results.filter((item) => !item.error).length;
  const pending = Number(
    (await dbGet(env, 'SELECT COUNT(*) AS count FROM books WHERE title_cleaned_at = 0')).count || 0
  );
  return json({
    ok: true,
    results,
    processed: results.length,
    cleaned,
    pending,
    batchLimit: limit,
    hasMore: pending > 0,
    finishedAt: nowSec(),
  });
}
