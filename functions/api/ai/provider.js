import { dbGet, dbRun, nowSec } from '../../utils/db.js';
import { requireAdmin } from '../../utils/auth.js';
import { err, json } from '../../utils/http.js';
import { decryptApiKey, encryptApiKey, normalizeBaseUrl, providerFetch } from '../../utils/ai-provider.js';

export async function onRequestGet(context) {
  const denied = requireAdmin(context);
  if (denied) return denied;
  const row = await dbGet(context.env, 'SELECT format, base_url, model, encrypted_key FROM ai_provider_config WHERE id=1');
  if (!row) return json({ ok: true, configured: false, format: 'openai', baseUrl: '', model: '', hasKey: false });
  return json({
    ok: true,
    configured: true,
    format: row.format,
    baseUrl: row.base_url,
    model: row.model,
    hasKey: Boolean(row.encrypted_key),
  });
}

export async function onRequestPut(context) {
  const denied = requireAdmin(context);
  if (denied) return denied;
  const body = await context.request.json().catch(() => ({}));
  const format = String(body.format || '');
  if (!['openai', 'anthropic'].includes(format)) return err('协议必须为 OpenAI 或 Anthropic');
  let baseUrl;
  try {
    baseUrl = normalizeBaseUrl(body.baseUrl);
  } catch (error) {
    return err(error.message);
  }
  const model = String(body.model || '').trim();
  if (!model || model.length > 200) return err('请填写有效模型名称');

  const existing = await dbGet(context.env, 'SELECT encrypted_key FROM ai_provider_config WHERE id=1');
  const apiKey = String(body.apiKey || '').trim();
  if (apiKey && apiKey.length > 4096) return err('API Key 长度超出限制');
  if (!apiKey && !existing?.encrypted_key) return err('请填写 API Key');

  let encryptedKey = existing?.encrypted_key || '';
  if (apiKey) {
    try {
      encryptedKey = await encryptApiKey(context.env, apiKey);
    } catch (error) {
      return err(error.message, 503);
    }
  }
  await dbRun(
    context.env,
    `INSERT INTO ai_provider_config (id, format, base_url, model, encrypted_key, updated_at)
     VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET format=excluded.format, base_url=excluded.base_url,
       model=excluded.model, encrypted_key=excluded.encrypted_key, updated_at=excluded.updated_at`,
    format,
    baseUrl,
    model,
    encryptedKey,
    nowSec(),
  );
  return json({ ok: true, configured: true, format, baseUrl, model, hasKey: true });
}

export async function onRequestDelete(context) {
  const denied = requireAdmin(context);
  if (denied) return denied;
  await dbRun(context.env, 'DELETE FROM ai_provider_config WHERE id=1');
  return json({ ok: true, configured: false });
}

export async function onRequestPost(context) {
  const denied = requireAdmin(context);
  if (denied) return denied;
  const body = await context.request.json().catch(() => ({}));
  const format = String(body.format || '');
  if (!['openai', 'anthropic'].includes(format)) return err('协议必须为 OpenAI 或 Anthropic');
  let baseUrl;
  try {
    baseUrl = normalizeBaseUrl(body.baseUrl);
  } catch (error) {
    return err(error.message);
  }
  const existing = await dbGet(context.env, 'SELECT encrypted_key FROM ai_provider_config WHERE id=1');
  let apiKey = String(body.apiKey || '').trim();
  if (!apiKey && existing?.encrypted_key) {
    try {
      apiKey = await decryptApiKey(context.env, existing.encrypted_key);
    } catch (error) {
      return err(error.message, 503);
    }
  }
  if (!apiKey) return err('请先填写 API Key');
  try {
    const models = await discoverModels({ format, baseUrl, apiKey });
    return json({ ok: true, models });
  } catch (error) {
    const rawMessage = String(error.message || error);
    const message = apiKey ? rawMessage.replaceAll(apiKey, '[已隐藏]') : rawMessage;
    return err(`获取模型失败：${message}`, error.status || 502);
  }
}

async function discoverModels({ format, baseUrl, apiKey }) {
  const endpoint = format === 'anthropic'
    ? appendPath(baseUrl, 'models')
    : appendPath(baseUrl, 'models');
  const headers = format === 'anthropic'
    ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
    : { Authorization: `Bearer ${apiKey}` };
  const response = await providerFetch(endpoint, { headers, signal: AbortSignal.timeout(20000) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(String(payload?.error?.message || payload?.message || `HTTP ${response.status}`).slice(0, 240));
    error.status = response.status === 401 || response.status === 403 ? 400 : 502;
    throw error;
  }
  const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  const models = list.map((item) => typeof item === 'string' ? item : item?.id || item?.name)
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => item.trim());
  if (!models.length) throw new Error('接口响应中没有可用模型列表');
  return [...new Set(models)].slice(0, 300);
}

function appendPath(base, path) {
  return `${base.replace(/\/+$/, '')}/${path}`;
}
