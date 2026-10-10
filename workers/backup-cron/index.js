// 定时把 CF-Book 的加密备份转存到 R2。
// Cloudflare Pages 不支持 Cron Triggers，所以定时导出放在这个独立 Worker 里。

const DEFAULT_KEEP = 14;
const PREFIX = 'backups/';

function safeEqual(a, b) {
  const left = String(a);
  const right = String(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

// 只保留最近 keep 份，避免 R2 里越堆越多
async function pruneBackups(env, keep) {
  const listed = await env.BACKUPS.list({ prefix: PREFIX });
  const keys = listed.objects.map((object) => object.key).sort().reverse();
  const stale = keys.slice(Math.max(1, keep));
  for (const key of stale) await env.BACKUPS.delete(key);
  return stale.length;
}

export async function runBackup(env) {
  const base = String(env.CF_BOOK_URL || '').replace(/\/+$/, '');
  if (!base || !env.ADMIN_TOKEN) throw new Error('缺少 CF_BOOK_URL 或 ADMIN_TOKEN 配置');

  const res = await fetch(`${base}/api/backup/export`, {
    headers: { 'x-admin-token': env.ADMIN_TOKEN },
  });
  if (!res.ok) throw new Error(`导出备份失败：HTTP ${res.status}`);
  const body = await res.text();

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const key = `${PREFIX}cf-book-backup-${stamp}.json`;
  await env.BACKUPS.put(key, body, { httpMetadata: { contentType: 'application/json' } });
  const pruned = await pruneBackups(env, Number(env.KEEP_BACKUPS) || DEFAULT_KEEP);
  return { key, bytes: body.length, pruned };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runBackup(env).catch((error) => console.error('定时备份失败', error)));
  },
  // 手动触发一次备份，便于验证配置是否正确
  async fetch(request, env) {
    const provided = request.headers.get('x-admin-token') || '';
    if (!env.ADMIN_TOKEN || !safeEqual(provided, env.ADMIN_TOKEN)) {
      return new Response('forbidden', { status: 403 });
    }
    try {
      return Response.json({ ok: true, ...(await runBackup(env)) });
    } catch (error) {
      return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
    }
  },
};
