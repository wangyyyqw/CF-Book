import { json, err } from '../../../utils/http.js';
import { requireAdmin } from '../../../utils/auth.js';
import { mergeTags } from '../../../utils/tag-admin.js';

export async function onRequestPost(context) {
  const denied = requireAdmin(context);
  if (denied) return denied;
  const body = await context.request.json().catch(() => null);
  if (!body) return err('请求体必须是 JSON');
  const result = await mergeTags(context.env, String(body.from || ''), String(body.to || ''));
  if (result.error) return err(result.error, result.status || 400);
  return json({ ok: true, ...result });
}
