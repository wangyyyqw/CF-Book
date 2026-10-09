import { json, err } from '../../utils/http.js';
import { dbAll, dbGet, dbRun, nowSec } from '../../utils/db.js';
import { requireAdmin } from '../../utils/auth.js';
import { classifyBook, dailyLimit, MAX_AI_ATTEMPTS } from '../../utils/ai-classification.js';

async function usedToday(env, start) {
  const row = await dbGet(env, 'SELECT COALESCE(SUM(neurons), 0) AS neurons FROM ai_usage WHERE created_at >= ?', start);
  return Number(row?.neurons || 0);
}

export async function onRequestGet(context) {
  const denied = requireAdmin(context);
  if (denied) return denied;
  const { env } = context;
  const start = Math.floor(Date.now() / 86400000) * 86400;
  const usage = await dbGet(
    env,
    `SELECT COALESCE(SUM(neurons), 0) AS neurons, COUNT(*) AS requests,
       COALESCE(SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END), 0) AS completed,
       COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END), 0) AS failed
     FROM ai_usage WHERE created_at >= ?`,
    start
  );
  const pending = await dbGet(env, `SELECT COUNT(*) AS count FROM books b LEFT JOIN ai_classifications a ON a.book_id=b.id WHERE a.book_id IS NULL OR a.status = 'pending' OR (a.status = 'failed' AND a.attempts < ?)`, MAX_AI_ATTEMPTS);
  const total = await dbGet(env, 'SELECT COUNT(*) AS count FROM books');
  return json({
    ok: true,
    date: new Date().toISOString().slice(0, 10),
    usedNeurons: Number(usage.neurons || 0),
    dailyLimit: dailyLimit(env),
    requests: Number(usage.requests || 0),
    completed: Number(usage.completed || 0),
    failed: Number(usage.failed || 0),
    pending: Number(pending.count || 0),
    totalBooks: Number(total.count || 0),
  });
}

export async function onRequestPost(context) {
  const denied = requireAdmin(context);
  if (denied) return denied;
  const { env, request } = context;
  const body = await request.json().catch(() => ({}));
  const limit = Math.min(Math.max(Number(body.limit) || 10, 1), 50);
  const force = body.force === true;
  const start = Math.floor(Date.now() / 86400000) * 86400;
  if (await usedToday(env, start) >= dailyLimit(env)) return err('今日 AI 额度已用尽', 429);

  const books = await dbAll(
    env,
    `SELECT b.id FROM books b LEFT JOIN ai_classifications a ON a.book_id=b.id
     WHERE ?=1 OR a.book_id IS NULL OR a.status = 'pending' OR (a.status = 'failed' AND a.attempts < ?)
     ORDER BY b.created_at ASC LIMIT ?`,
    force ? 1 : 0,
    MAX_AI_ATTEMPTS,
    limit
  );
  const results = [];
  for (const book of books) {
    if (await usedToday(env, start) >= dailyLimit(env)) break;
    try {
      results.push(await classifyBook(env, book.id, { force }));
    } catch (error) {
      results.push({ bookId: book.id, error: error.message });
    }
  }
  return json({ ok: true, results, processed: results.length, finishedAt: nowSec() });
}
