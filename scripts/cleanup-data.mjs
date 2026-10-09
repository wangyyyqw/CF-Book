#!/usr/bin/env node
/**
 * 清理 CF-Book 已上传的数据。
 *
 * 依次删除：Telegram 私有频道里的分块消息 → D1 记录 → R2 封面。
 * 默认只空跑并打印清单，必须显式加 --yes 才会真正删除。
 *
 *   node scripts/cleanup-data.mjs          # 空跑，列出将要删除的内容
 *   node scripts/cleanup-data.mjs --yes    # 真正执行删除
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--yes');
const DB = '[D1_DATABASE_NAME]';
const COVER_BUCKET = '[R2_BUCKET_NAME]';
// 换过封面时旧扩展名的对象会残留，逐个扩展名尝试删除，删不存在的 key 是安全的
const COVER_EXTS = ['jpg', 'png', 'webp', 'gif'];
const TG_CONCURRENCY = 5;

// D1 清空的表，顺序无关，但放在一起执行
const TABLES = ['chunks', 'uploads', 'book_user_state', 'book_tags', 'tags', 'books'];

function loadDevVars() {
  const vars = {};
  let text;
  try {
    text = readFileSync(join(ROOT, '.dev.vars'), 'utf8');
  } catch {
    return vars;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    vars[trimmed.slice(0, eq).trim()] = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  }
  return vars;
}

function d1(sql) {
  const out = retry(() =>
    execFileSync('npx', ['wrangler', 'd1', 'execute', DB, '--remote', '--json', '--command', sql], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  );
  const start = out.indexOf('[');
  if (start < 0) throw new Error(`无法解析 D1 输出：\n${out}`);
  return JSON.parse(out.slice(start)).flatMap((set) => set.results || []);
}

function r2Delete(key) {
  retry(() =>
    execFileSync('npx', ['wrangler', 'r2', 'object', 'delete', `${COVER_BUCKET}/${key}`, '--remote'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  );
}

// wrangler 走 Cloudflare API，偶发瞬时失败；重试几次再放弃
function retry(fn, attempts = 4) {
  for (let i = 1; ; i++) {
    try {
      return fn();
    } catch (e) {
      if (i >= attempts) throw e;
      console.error(`  第 ${i} 次失败，重试…`);
      execFileSync('sleep', ['3']);
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function deleteTelegramMessage(token, chatId, messageId, attempt = 0) {
  const res = await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
  });
  const data = await res.json().catch(() => ({}));
  if (data.ok) return 'deleted';
  const desc = String(data.description || '');
  // 消息已经不在了，视为已清理
  if (/message to delete not found/i.test(desc)) return 'gone';
  if (res.status === 429 && attempt < 3) {
    await sleep((data.parameters?.retry_after || 2) * 1000);
    return deleteTelegramMessage(token, chatId, messageId, attempt + 1);
  }
  throw new Error(`Telegram 删除失败 (message_id=${messageId})：${desc || res.status}`);
}

async function mapLimit(items, limit, fn) {
  const results = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function coverKeys(book) {
  const id = String(book.id || '');
  if (!id) return [];
  return COVER_EXTS.map((ext) => `covers/${id}.${ext}`);
}

async function main() {
  const vars = loadDevVars();
  const token = vars.TG_BOT_TOKEN;
  if (!token) throw new Error('缺少 TG_BOT_TOKEN（.dev.vars）');
  const fallbackChat = vars.TG_CHAT_ID || '';

  const chunks = d1(
    'SELECT upload_id, idx, tg_message_id, tg_chat_id FROM chunks WHERE tg_message_id IS NOT NULL ORDER BY upload_id, idx;'
  );
  const books = d1('SELECT id, title, cover FROM books ORDER BY created_at;');
  const counts = d1(
    TABLES.map((t) => `(SELECT COUNT(*) FROM ${t}) AS ${t}`).join(', ').replace(/^/, 'SELECT ') + ';'
  )[0];

  console.log('=== 当前已上传数据 ===');
  console.log(`书籍 ${counts.books} 本 / 上传任务 ${counts.uploads} 个 / 分块 ${counts.chunks} 块`);
  console.log(
    `个人状态 ${counts.book_user_state} 条 / 标签 ${counts.tags} 个 / 书签关联 ${counts.book_tags} 条`
  );
  console.log(`Telegram 待删消息 ${chunks.length} 条 / R2 封面候选 ${books.filter((b) => b.cover).length} 本`);
  console.log('\n书籍清单：');
  for (const b of books) console.log(`  - ${b.title}${b.cover ? `（封面 ${b.cover}）` : ''}`);

  if (!APPLY) {
    console.log('\n空跑结束，未做任何改动。确认无误后加 --yes 执行删除。');
    return;
  }

  console.log('\n=== 开始清理 ===');

  const tgResults = await mapLimit(chunks, TG_CONCURRENCY, (c) =>
    deleteTelegramMessage(token, c.tg_chat_id || fallbackChat, c.tg_message_id)
  );
  console.log(
    `Telegram 消息：删除 ${tgResults.filter((r) => r === 'deleted').length} 条，` +
      `本就已不存在 ${tgResults.filter((r) => r === 'gone').length} 条`
  );

  d1(`DELETE FROM chunks; DELETE FROM uploads; DELETE FROM book_user_state; DELETE FROM book_tags; DELETE FROM tags; DELETE FROM books;`);
  console.log('D1 记录已清空');

  let coverDeleted = 0;
  for (const book of books) {
    for (const key of coverKeys(book)) {
      r2Delete(key);
      coverDeleted += 1;
    }
  }
  console.log(`R2 封面已清理（尝试删除 ${coverDeleted} 个 key）`);

  const after = d1(
    TABLES.map((t) => `(SELECT COUNT(*) FROM ${t}) AS ${t}`).join(', ').replace(/^/, 'SELECT ') + ';'
  )[0];
  const leftover = Object.entries(after).filter(([, n]) => n > 0);
  console.log('\n=== 复核 ===');
  console.log(`剩余记录：${leftover.length ? JSON.stringify(Object.fromEntries(leftover)) : '全部为 0'}`);
  if (leftover.length) {
    throw new Error('清理不完整，请检查上面的剩余记录');
  }
}

main().catch((e) => {
  console.error(`\n清理失败：${e.message}`);
  process.exitCode = 1;
});
