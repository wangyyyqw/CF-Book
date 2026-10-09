import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost } from '../functions/api/upload/init.js';
import { createD1 } from './helpers/d1.mjs';

function context(env, body) {
  return {
    env,
    request: new Request('https://example.com/api/upload/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    data: { user: { username: 'admin', role: 'admin' } },
  };
}

test('相同文件重新初始化时复用未完成任务并返回已上传分块', async () => {
  const env = { DB: createD1() };
  const first = await onRequestPost(context(env, {
    filename: 'resume.epub', size: 33 * 1024 * 1024, chunkSize: 16 * 1024 * 1024,
    sha256: 'a'.repeat(64), mime: 'application/epub+zip',
  }));
  const firstData = await first.json();
  await env.DB.prepare("UPDATE chunks SET status='uploaded' WHERE upload_id=? AND idx IN (0, 1)")
    .bind(firstData.uploadId).run();
  await env.DB.prepare("UPDATE uploads SET status='aborted' WHERE upload_id=?")
    .bind(firstData.uploadId).run();

  const resumed = await onRequestPost(context(env, {
    filename: 'resume.epub', size: 33 * 1024 * 1024, chunkSize: 16 * 1024 * 1024,
    sha256: 'a'.repeat(64), mime: 'application/epub+zip',
  }));
  const data = await resumed.json();
  assert.equal(data.resumed, true);
  assert.equal(data.uploadId, firstData.uploadId);
  assert.deepEqual(data.uploadedChunks, [0, 1]);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS count FROM uploads').first()).count, 1);
});
