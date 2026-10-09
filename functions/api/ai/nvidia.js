import { dbGet, dbRun, nowSec } from '../../utils/db.js';
import { requireAdmin } from '../../utils/auth.js';
import { err, json } from '../../utils/http.js';
import { decryptKeys, encryptKeys, maskKey } from '../../utils/nvidia.js';

const DEFAULT_MODEL = 'deepseek-ai/deepseek-v4.1-flash';
const MODEL_RE = /^[A-Za-z0-9._/-]{2,160}$/;

export async function onRequestGet(context) {
  const denied = requireAdmin(context);
  if (denied) return denied;
  const row = await dbGet(context.env, 'SELECT model, encrypted_keys FROM nvidia_ai_config WHERE id = 1');
  if (!row) return json({ ok: true, model: DEFAULT_MODEL, keys: [] });
  const keys = await decryptKeys(context.env, row.encrypted_keys);
  return json({ ok: true, model: row.model, keys: keys.map(maskKey) });
}

export async function onRequestPut(context) {
  const denied = requireAdmin(context);
  if (denied) return denied;
  const body = await context.request.json().catch(() => ({}));
  const model = String(body.model || '').trim();
  if (!MODEL_RE.test(model)) return err('模型名称格式不正确');
  if (!Array.isArray(body.keys) || body.keys.length > 10) return err('密钥必须是最多 10 个的列表');
  const keys = [...new Set(body.keys.map((item) => String(item).trim()).filter(Boolean))];
  if (keys.some((item) => item.length > 512 || !/^nvapi-[A-Za-z0-9_-]+$/.test(item))) {
    return err('NVIDIA 密钥格式无效');
  }
  let encrypted;
  if (!keys.length) {
    await dbRun(context.env, 'DELETE FROM nvidia_ai_config WHERE id = 1');
    return json({ ok: true, model, keys: [] });
  }
  try {
    encrypted = await encryptKeys(context.env, keys);
  } catch (error) {
    return err(error.message, 503);
  }
  await dbRun(
    context.env,
    `INSERT INTO nvidia_ai_config (id, model, encrypted_keys, next_key, updated_at)
     VALUES (1, ?, ?, 0, ?)
     ON CONFLICT(id) DO UPDATE SET model=excluded.model, encrypted_keys=excluded.encrypted_keys, next_key=0, updated_at=excluded.updated_at`,
    model,
    encrypted,
    nowSec()
  );
  return json({ ok: true, model, keys: keys.map(maskKey) });
}
