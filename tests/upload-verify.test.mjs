import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost } from '../functions/api/upload/[uploadId]/verify.js';
import { createD1 } from './helpers/d1.mjs';

function makeEnv() {
  const DB = createD1();
  DB.exec(
    `INSERT INTO users (id, username, display_name, password_hash, role, disabled, created_at, updated_at)
     VALUES ('u1', 'admin', '管理员', 'x', 'admin', 0, 0, 0),
            ('u2', 'member', '成员', 'x', 'member', 0, 0, 0)`
  );
  DB.exec(
    `INSERT INTO uploads
       (upload_id, filename, mime, total_size, chunk_size, total_chunks, sha256, status, owner,
        verified_at, verify_result, created_at, updated_at)
     VALUES ('up1', 'book.epub', 'application/epub+zip', 30, 10, 3, '', 'completed', 'admin', 0, '', 0, 0)`
  );
  DB.exec(
    `INSERT INTO chunks (upload_id, idx, size, sha256, status, tg_chat_id, tg_message_id, tg_file_id, error, retries, updated_at)
     VALUES ('up1', 0, 10, '', 'uploaded', '-100', 1, 'FILE0', '', 0, 0),
            ('up1', 1, 10, '', 'uploaded', '-100', 2, 'FILE1', '', 0, 0),
            ('up1', 2, 10, '', 'uploaded', '-100', 3, 'FILE2', '', 0, 0)`
  );
  return { DB, TG_BOT_TOKEN: 'token', TG_CHAT_ID: '-100' };
}

function stubTelegram({ missing = [], size = 10 } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const fileId = new URL(String(url)).searchParams.get('file_id');
    if (missing.includes(fileId)) {
      return Response.json({ ok: false, description: 'file is not found' }, { status: 400 });
    }
    return Response.json({ ok: true, result: { file_id: fileId, file_path: `p/${fileId}`, file_size: size } });
  };
  return () => {
    globalThis.fetch = original;
  };
}

function ctx(env, user = { username: 'admin', role: 'admin' }) {
  return {
    env,
    params: { uploadId: 'up1' },
    data: { user },
    request: new Request('https://example.com/api/upload/up1/verify', { method: 'POST' }),
  };
}

test('校验全部分块都在 Telegram 上并记录结果', async () => {
  const env = makeEnv();
  const restore = stubTelegram();
  try {
    const data = await (await onRequestPost(ctx(env))).json();
    assert.equal(data.ok, true);
    assert.deepEqual(data.verified, { total: 3, ok: 3, bad: 0, badChunks: [] });
    const row = await env.DB.prepare('SELECT verified_at, verify_result FROM uploads WHERE upload_id = ?')
      .bind('up1')
      .first();
    assert.ok(row.verified_at > 0);
    assert.equal(JSON.parse(row.verify_result).ok, 3);
  } finally {
    restore();
  }
});

test('Telegram 上已丢失的分块会被列出来，D1 记录保持不变', async () => {
  const env = makeEnv();
  const restore = stubTelegram({ missing: ['FILE1'] });
  try {
    const data = await (await onRequestPost(ctx(env))).json();
    assert.equal(data.verified.bad, 1);
    assert.deepEqual(data.verified.badChunks.map((item) => item.index), [1]);
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM chunks WHERE upload_id = ?').bind('up1').first();
    assert.equal(count.n, 3, '校验不得删除任何分块记录');
  } finally {
    restore();
  }
});

test('非管理员不能校验他人上传的任务', async () => {
  const env = makeEnv();
  const res = await onRequestPost(ctx(env, { username: 'member', role: 'member' }));
  assert.equal(res.status, 403);
});
