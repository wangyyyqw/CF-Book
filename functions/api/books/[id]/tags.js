import { json, err } from '../../../utils/http.js';
import { dbGet } from '../../../utils/db.js';
import { requireAdmin } from '../../../utils/auth.js';
import { validateTagIdList, replaceStandardTags, standardTagDetails } from '../../../utils/standard-tags.js';

// 标准标签编辑统一收敛到管理员：与书籍编辑页（/api/books/:id）口径一致，避免成员绕过 UI 直接改共享分类
export async function onRequestPut(context) {
  const denied = requireAdmin(context);
  if (denied) return denied;
  const { request, env, params } = context;
  const book = await dbGet(env, 'SELECT id FROM books WHERE id = ?', params.id);
  if (!book) return err('书籍不存在', 404);

  const body = await request.json().catch(() => null);
  if (!body) return err('请求体必须是 JSON');

  const parsed = await validateTagIdList(env, body.tagIds);
  if (parsed.error) return err(parsed.error);
  await replaceStandardTags(env, params.id, parsed.tagIds);
  const tags = await standardTagDetails(env, params.id);
  return json({ ok: true, tags: parsed.tagIds.map((tagId) => tags.find((tag) => tag.tag_id === tagId)?.name) });
}
