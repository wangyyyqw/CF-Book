import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestDelete, onRequestGet, onRequestPost, onRequestPut } from '../functions/api/ai/provider.js';
import { createD1 } from './helpers/d1.mjs';
import { decryptApiKey, providerFetch } from '../functions/utils/ai-provider.js';

function setup() {
  const DB = createD1();
  return { DB, env: { DB, ADMIN_TOKEN: 'test-only-admin-token-placeholder' }, admin: { data: { user: { role: 'admin' } } } };
}

function request(method, body) {
  return new Request('https://example.test/api/ai/provider', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('自定义 AI 配置加密保存密钥，查询配置不返回密钥', async () => {
  const { DB, env, admin } = setup();
  const response = await onRequestPut({ ...admin, env, request: request('PUT', {
    format: 'openai', baseUrl: 'https://api.example.com/v1/', model: 'demo-chat', apiKey: 'secret-api-key',
  }) });
  assert.equal(response.status, 200);
  const row = await DB.prepare('SELECT * FROM ai_provider_config WHERE id=1').first();
  assert.doesNotMatch(row.encrypted_key, /secret-api-key/);
  assert.equal(await decryptApiKey(env, row.encrypted_key), 'secret-api-key');
  const result = await (await onRequestGet({ ...admin, env })).json();
  assert.equal(result.model, 'demo-chat');
  assert.equal(result.baseUrl, 'https://api.example.com/v1');
  assert.equal(result.hasKey, true);
  assert.doesNotMatch(JSON.stringify(result), /secret-api-key/);
});

test('模型发现使用 OpenAI Bearer 与 Anthropic x-api-key 协议', async () => {
  const { env, admin } = setup();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), headers: options.headers });
    return new Response(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }), { status: 200 });
  };
  try {
    for (const format of ['openai', 'anthropic']) {
      const response = await onRequestPost({ ...admin, env, request: request('POST', {
        format, baseUrl: `https://provider.example/${format === 'openai' ? 'v1' : 'v1'}`, apiKey: `${format}-secret`,
      }) });
      assert.deepEqual((await response.json()).models, ['model-a', 'model-b']);
    }
    assert.equal(calls[0].url, 'https://provider.example/v1/models');
    assert.equal(calls[0].headers.Authorization, 'Bearer openai-secret');
    assert.equal(calls[1].headers['x-api-key'], 'anthropic-secret');
    assert.equal(calls[1].headers['anthropic-version'], '2023-06-01');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('自定义 AI 配置仅管理员可操作并拒绝非 HTTPS、本机及内网 URL', async () => {
  const { env } = setup();
  const denied = await onRequestGet({ env, data: { user: { role: 'member' } } });
  assert.equal(denied.status, 403);
  const invalid = await onRequestPut({
    env,
    data: { user: { role: 'admin' } },
    request: request('PUT', { format: 'openai', baseUrl: 'http://localhost/v1', model: 'm', apiKey: 'secret' }),
  });
  assert.equal(invalid.status, 400);
  for (const baseUrl of ['https://localhost/v1', 'https://192.168.1.4/v1', 'https://10.0.0.1/v1', 'https://service.local/v1', 'https://[::ffff:127.0.0.1]/v1']) {
    const response = await onRequestPut({
      env,
      data: { user: { role: 'admin' } },
      request: request('PUT', { format: 'openai', baseUrl, model: 'm', apiKey: 'secret' }),
    });
    assert.equal(response.status, 400, baseUrl);
  }
});

test('删除自定义 AI 配置后恢复默认 AI', async () => {
  const { DB, env, admin } = setup();
  await DB.prepare(`INSERT INTO ai_provider_config (id, format, base_url, model, encrypted_key) VALUES (1,'openai','https://a/v1','m','cipher')`).run();
  const response = await onRequestDelete({ ...admin, env });
  assert.equal(response.status, 200);
  assert.equal(await DB.prepare('SELECT id FROM ai_provider_config WHERE id=1').first(), null);
});

test('自定义 Provider 请求使用 Cloudflare 支持的手动重定向策略', async () => {
  const originalFetch = globalThis.fetch;
  let redirectMode;
  globalThis.fetch = async (_input, options) => {
    redirectMode = options.redirect;
    return new Response('', { status: 302, headers: { Location: 'https://internal.example/' } });
  };
  try {
    const response = await providerFetch('https://provider.example/models');
    assert.equal(redirectMode, 'manual');
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), 'https://internal.example/');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
