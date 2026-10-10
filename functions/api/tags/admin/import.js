import { json, err } from '../../../utils/http.js';
import { requireAdmin } from '../../../utils/auth.js';
import { importTags } from '../../../utils/tag-admin.js';

export async function onRequestPost(context) {
  const denied = requireAdmin(context);
  if (denied) return denied;
  const body = await context.request.json().catch(() => null);
  if (!body) return err('请求体必须是 JSON');
  const result = await importTags(context.env, body);
  if (result.error) return err(result.error, result.status || 400);
  return json({ ok: true, ...result });
}
