import { json, err } from '../../utils/http.js';
import { requireAdmin } from '../../utils/auth.js';
import { createTag, deleteTag, listTagLibrary, updateTag } from '../../utils/tag-admin.js';

export async function onRequestGet(context) {
  const denied = requireAdmin(context);
  if (denied) return denied;
  return json({ ok: true, ...(await listTagLibrary(context.env)) });
}

export async function onRequestPost(context) {
  const denied = requireAdmin(context);
  if (denied) return denied;
  const body = await context.request.json().catch(() => null);
  if (!body) return err('请求体必须是 JSON');
  const result = await createTag(context.env, body);
  if (result.error) return err(result.error, result.status || 400);
  return json({ ok: true, tag: result.tag });
}

export async function onRequestPut(context) {
  const denied = requireAdmin(context);
  if (denied) return denied;
  const body = await context.request.json().catch(() => null);
  if (!body?.tagId) return err('缺少 tagId');
  const result = await updateTag(context.env, String(body.tagId), body);
  if (result.error) return err(result.error, result.status || 400);
  return json({ ok: true, tag: result.tag });
}

export async function onRequestDelete(context) {
  const denied = requireAdmin(context);
  if (denied) return denied;
  const tagId = new URL(context.request.url).searchParams.get('tag_id') || '';
  if (!tagId) return err('缺少 tag_id');
  const result = await deleteTag(context.env, tagId);
  if (result.error) return err(result.error, result.status || 400);
  return json({ ok: true, ...result });
}
