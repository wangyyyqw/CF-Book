import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost } from '../functions/api/upload/cleanup.js';
import { createD1 } from './helpers/d1.mjs';

const DAY = 86400;
const now = Math.floor(Date.now() / 1000);

function makeEnv() {
  const DB = createD1();
  DB.exec(
    `INSERT INTO users (id, username, display_name, password_hash, role, disabled, created_at, updated_at)
     VALUES ('u1', 'admin', '管理员', 'x', 'admin', 0, 0, 0),
            ('u2', 'member', '成员', 'x', 'member', 0, 0, 0)`
  );
  const upload = (id, status, updatedAt) => `('${id}', '${id}.epub', 'application/epub+zip', 10, 10, 1, '', '${status}', 'admin', 0, '', ${updatedAt}, ${updatedAt})`;
  DB.exec(
    `INSERT INTO uploads
       (upload_id, filename, mime, total_size, chunk_size, total_chunks, sha256, status, owner,
        verified_at, verify_result, created_at, updated_at)
     VALUES ${upload('stale-empty', 'active', now - 40 * DAY)},
            ${upload('stale-partial', 'active', now - 40 * DAY)},
            ${upload('fresh', 'active', now)},
            ${upload('done-old', 'completed', now - 40 * DAY)}`
  );
  DB.exec(
    `INSERT INTO chunks (upload_id, idx, size, sha256, status, tg_chat_id, tg_message_id, tg_file_id, error, retries, updated_at)
     VALUES ('stale-empty', 0, 10, '', 'pending', '', NULL, '', '', 0, 0),
            ('stale-partial', 0, 10, '', 'uploaded', '-100', 1, 'FILE', '', 0, 0),
            ('fresh', 0, 10, '', 'pending', '', NULL, '', '', 0, 0),
            ('done-old', 0, 10, '', 'uploaded', '-100', 2, 'FILE', '', 0, 0)`
  );
  return { DB };
}

function ctx(env, body = {}, user = { id: 'u1', username: 'admin', role: 'admin' }) {
  return {
    env,
    data: { user },
    request: new Request('https://example.com/api/upload/cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  };
}

test('清理长期失效任务：无分块的删除，有分块的改为 aborted', async () => {
  const env = makeEnv();
  const data = await (await onRequestPost(ctx(env))).json();
  assert.equal(data.ok, true);
  assert.equal(data.deleted, 1);
  assert.equal(data.aborted, 1);

  const remaining = await env.DB.prepare('SELECT upload_id, status FROM uploads ORDER BY upload_id').all();
  assert.deepEqual(remaining.results.map((row) => [row.upload_id, row.status]), [
    ['done-old', 'completed'],
    ['fresh', 'active'],
    ['stale-partial', 'aborted'],
  ]);
  const orphan = await env.DB.prepare("SELECT COUNT(*) AS n FROM chunks WHERE upload_id = 'stale-empty'").first();
  assert.equal(orphan.n, 0, '被删除的任务不能留下分块记录');
});

test('未超过期限的任务不受影响', async () => {
  const env = makeEnv();
  await onRequestPost(ctx(env, { days: 90 }));
  const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM uploads').first();
  assert.equal(rows.n, 4);
});

test('非管理员不能触发清理', async () => {
  const env = makeEnv();
  const res = await onRequestPost(ctx(env, {}, { id: 'u2', username: 'member', role: 'member' }));
  assert.equal(res.status, 403);
  const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM uploads').first();
  assert.equal(rows.n, 4);
});
