import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet, onRequestPut } from '../functions/api/ai/nvidia.js';
import { createD1 } from './helpers/d1.mjs';

function setup() {
  const DB = createD1();
  return {
    DB,
    env: { DB, ADMIN_TOKEN: 'test-only-admin-token-placeholder' },
    admin: { data: { user: { role: 'admin' } } },
  };
}

test('NVIDIA 设置只返回遮罩密钥，密钥以密文保存并可轮换读取', async () => {
  const { DB, env, admin } = setup();
  const put = await onRequestPut({
    ...admin,
    env,
    request: new Request('https://example.test/api/ai/nvidia', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-ai/deepseek-v4-pro', keys: ['nvapi-secret-one', 'nvapi-secret-two'] }),
    }),
  });
  assert.equal(put.status, 200);
  const saved = await DB.prepare('SELECT encrypted_keys FROM nvidia_ai_config WHERE id = 1').first();
  assert.doesNotMatch(saved.encrypted_keys, /nvapi-secret/);
  const response = await onRequestGet({ ...admin, env });
  const data = await response.json();
  assert.equal(data.model, 'deepseek-ai/deepseek-v4-pro');
  assert.deepEqual(data.keys, ['nvapi-****-one', 'nvapi-****-two']);
  assert.doesNotMatch(JSON.stringify(data), /nvapi-secret/);
});

test('NVIDIA 配置拒绝非管理员和空模型', async () => {
  const { env, admin } = setup();
  const denied = await onRequestGet({ env, data: { user: { role: 'member' } } });
  assert.equal(denied.status, 403);
  const invalid = await onRequestPut({
    ...admin,
    env,
    request: new Request('https://example.test/api/ai/nvidia', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: '', keys: ['nvapi-x'] }),
    }),
  });
  assert.equal(invalid.status, 400);
});

test('空密钥列表会删除旧 NVIDIA 配置以恢复 Workers AI', async () => {
  const { DB, env, admin } = setup();
  await DB.prepare("INSERT INTO nvidia_ai_config (id, model, encrypted_keys, next_key) VALUES (1, 'm', '[]', 0)").run();
  const response = await onRequestPut({
    ...admin,
    env,
    request: new Request('https://example.test/api/ai/nvidia', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'test/model', keys: [] }),
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(await DB.prepare('SELECT id FROM nvidia_ai_config WHERE id=1').first(), null);
});
