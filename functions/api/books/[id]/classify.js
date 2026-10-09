import { json, err } from '../../../utils/http.js';
import { dbGet } from '../../../utils/db.js';
import { requireAdmin } from '../../../utils/auth.js';
import { classifyBook } from '../../../utils/ai-classification.js';

export async function onRequestPost(context) {
  const denied = requireAdmin(context);
  if (denied) return denied;
  const { env, params } = context;
  const book = await dbGet(env, 'SELECT id FROM books WHERE id = ?', params.id);
  if (!book) return err('书籍不存在', 404);

  try {
    const result = await classifyBook(env, book.id, { force: true, includeDebug: true });
    return json({ ok: true, result });
  } catch (error) {
    const debug = error.debug ? { ...error.debug } : null;
    return json({
      ok: false,
      error: error.message || '分类失败',
      debug,
      retryAfterSeconds: error.retryAfterSeconds || 0,
    }, 502);
}
}
