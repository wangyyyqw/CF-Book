import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { runBackup } from '../workers/backup-cron/index.js';

function fakeBucket(initial = []) {
  const objects = new Map(initial.map((key) => [key, 'x']));
  return {
    objects,
    async put(key, value) {
      objects.set(key, value);
    },
    async delete(key) {
      objects.delete(key);
    },
    async list({ prefix }) {
      return { objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })) };
    },
  };
}

function stubFetch(response) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return response;
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('定时任务把加密备份写入 R2 并带上管理员令牌', async () => {
  const env = { CF_BOOK_URL: 'https://cf-book.pages.dev/', ADMIN_TOKEN: 'secret', BACKUPS: fakeBucket() };
  const { calls, restore } = stubFetch(new Response('{"encrypted":true}', { status: 200 }));
  try {
    const result = await runBackup(env);
    assert.equal(calls[0].url, 'https://cf-book.pages.dev/api/backup/export');
    assert.equal(calls[0].options.headers['x-admin-token'], 'secret');
    assert.match(result.key, /^backups\/cf-book-backup-.*\.json$/);
    assert.equal(env.BACKUPS.objects.get(result.key), '{"encrypted":true}');
  } finally {
    restore();
  }
});

test('只保留最近 N 份备份', async () => {
  const old = Array.from({ length: 5 }, (_, i) => `backups/cf-book-backup-2026-01-0${i + 1}T00-00-00-000Z.json`);
  const env = { CF_BOOK_URL: 'https://cf-book.pages.dev', ADMIN_TOKEN: 'secret', KEEP_BACKUPS: '3', BACKUPS: fakeBucket(old) };
  const { restore } = stubFetch(new Response('{}', { status: 200 }));
  try {
    const result = await runBackup(env);
    assert.equal(result.pruned, 3);
    assert.equal(env.BACKUPS.objects.size, 3);
    assert.ok(env.BACKUPS.objects.has(result.key), '最新一份必须保留');
  } finally {
    restore();
  }
});

test('缺少配置或导出失败时抛出可读错误', async () => {
  await assert.rejects(() => runBackup({ BACKUPS: fakeBucket() }), /CF_BOOK_URL/);
  const { restore } = stubFetch(new Response('nope', { status: 502 }));
  try {
    await assert.rejects(
      () => runBackup({ CF_BOOK_URL: 'https://x.dev', ADMIN_TOKEN: 't', BACKUPS: fakeBucket() }),
      /HTTP 502/
    );
  } finally {
    restore();
  }
});

test('手动触发需要正确的管理员令牌', async () => {
  const env = { CF_BOOK_URL: 'https://cf-book.pages.dev', ADMIN_TOKEN: 'secret', BACKUPS: fakeBucket() };
  const denied = await worker.fetch(new Request('https://backup.example.com/', { headers: { 'x-admin-token': 'wrong' } }), env);
  assert.equal(denied.status, 403);

  const { restore } = stubFetch(new Response('{}', { status: 200 }));
  try {
    const ok = await worker.fetch(new Request('https://backup.example.com/', { headers: { 'x-admin-token': 'secret' } }), env);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).ok, true);
  } finally {
    restore();
  }
});
