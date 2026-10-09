import { json, err } from '../../../utils/http.js';
import { dbGet } from '../../../utils/db.js';
import { parseTags } from '../../../utils/books.js';
import { replaceTags } from '../../../utils/tags.js';

// 标签是共享的：任何登录账号都可以整理
export async function onRequestPut(context) {
  const { request, env, params } = context;
  const book = await dbGet(env, 'SELECT id FROM books WHERE id = ?', params.id);
  if (!book) return err('书籍不存在', 404);

  const body = await request.json().catch(() => null);
  if (!body) return err('请求体必须是 JSON');

  const parsed = parseTags(body.tags);
  if (parsed.error) return err(parsed.error);
  await replaceTags(env, params.id, parsed.tags);
  return json({ ok: true, tags: parsed.tags });
}
