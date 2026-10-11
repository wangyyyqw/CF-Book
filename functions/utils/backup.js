import { dbAll, dbGet, nowSec } from './db.js';

export const BACKUP_FORMAT = 'cf-book-backup';
export const BACKUP_VERSION = 1;
// Cloudflare 的 WebCrypto 实现拒绝超过 10 万次的 PBKDF2 迭代，这里与登录口令保持同一强度
const KDF_ITERATIONS = 100000;
const BATCH_SIZE = 100;

// 备份范围固定为这些表。uploads/chunks 是 Telegram 原文件的 D1 索引，
// 必须和书目一起备份，否则恢复后书还在但原文件已经找不回来。
export const BACKUP_TABLES = [
  { name: 'users', columns: ['id', 'username', 'display_name', 'password_hash', 'role', 'disabled', 'created_at', 'updated_at'] },
  { name: 'books', columns: ['id', 'upload_id', 'title', 'author', 'description', 'cover', 'format', 'isbn', 'publisher', 'language', 'file_name', 'file_size', 'sha256', 'created_by', 'created_at', 'updated_at', 'title_cleaned_at'] },
  { name: 'uploads', columns: ['upload_id', 'filename', 'mime', 'total_size', 'chunk_size', 'total_chunks', 'sha256', 'status', 'owner', 'verified_at', 'verify_result', 'created_at', 'updated_at'] },
  { name: 'chunks', columns: ['upload_id', 'idx', 'size', 'sha256', 'status', 'tg_chat_id', 'tg_message_id', 'tg_file_id', 'error', 'retries', 'updated_at'] },
  { name: 'book_user_state', columns: ['book_id', 'user_id', 'rating', 'status', 'is_favorite', 'comment', 'updated_at'] },
  { name: 'shelves', columns: ['id', 'name', 'description', 'scope', 'owner', 'created_by', 'sort_order', 'created_at', 'updated_at'] },
  { name: 'shelf_books', columns: ['shelf_id', 'book_id', 'added_by', 'added_at'] },
  { name: 'tag_dimensions', columns: ['dimension', 'name_zh', 'description'] },
  { name: 'standard_tags', columns: ['tag_id', 'name', 'dimension', 'category', 'parent_id', 'description', 'status'] },
  { name: 'standard_tag_aliases', columns: ['alias_id', 'tag_id', 'alias'] },
  { name: 'book_standard_tags', columns: ['book_id', 'tag_id'] },
  { name: 'tags', columns: ['id', 'name', 'category'] },
  { name: 'book_tags', columns: ['book_id', 'tag_id'] },
];

const TABLE_NAMES = new Set(BACKUP_TABLES.map((table) => table.name));

function toBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fromBase64(text) {
  const binary = atob(String(text));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveKey(secret, salt, iterations) {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function exportTables(env) {
  const tables = {};
  const counts = {};
  for (const table of BACKUP_TABLES) {
    const rows = await dbAll(env, `SELECT ${table.columns.join(', ')} FROM ${table.name}`);
    tables[table.name] = rows;
    counts[table.name] = rows.length;
  }
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, createdAt: nowSec(), counts, tables };
}

export async function encryptBackup(backup, secret) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(secret, salt, KDF_ITERATIONS);
  const plain = new TextEncoder().encode(JSON.stringify(backup));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    encrypted: true,
    createdAt: backup.createdAt,
    counts: backup.counts,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: KDF_ITERATIONS, salt: toBase64(salt) },
    cipher: { name: 'AES-GCM', iv: toBase64(iv), data: toBase64(new Uint8Array(data)) },
  };
}

export async function decryptBackup(envelope, secret) {
  if (!envelope?.encrypted) return envelope;
  const key = await deriveKey(secret, fromBase64(envelope.kdf.salt), Number(envelope.kdf.iterations));
  let plain;
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(envelope.cipher.iv) },
      key,
      fromBase64(envelope.cipher.data)
    );
  } catch {
    throw new Error('备份解密失败：BACKUP_KEY 不正确或文件已损坏');
  }
  return JSON.parse(new TextDecoder().decode(plain));
}

export function validateBackup(backup) {
  if (!backup || typeof backup !== 'object') return '备份内容不是有效的 JSON 对象';
  if (backup.format !== BACKUP_FORMAT) return `备份格式不匹配：期望 ${BACKUP_FORMAT}`;
  if (Number(backup.version) !== BACKUP_VERSION) return `备份版本不受支持：${backup.version}`;
  if (!backup.tables || typeof backup.tables !== 'object') return '备份缺少数据表';
  for (const name of Object.keys(backup.tables)) {
    if (!TABLE_NAMES.has(name)) return `备份包含未知数据表：${name}`;
    if (!Array.isArray(backup.tables[name])) return `数据表 ${name} 不是数组`;
  }
  return null;
}

// 请求体里的备份可能是明文对象，也可能是用 BACKUP_KEY 加密过的信封
export async function openBackup(env, raw) {
  if (!raw || typeof raw !== 'object') throw new Error('缺少备份内容');
  if (!raw.encrypted) return raw;
  if (!env.BACKUP_KEY) throw new Error('未配置 BACKUP_KEY，无法解密备份文件');
  return decryptBackup(raw, env.BACKUP_KEY);
}

// 恢复前预览：逐表对比备份内条数与当前库条数
export async function previewBackup(env, backup) {
  const summary = {};
  for (const table of BACKUP_TABLES) {
    const rows = backup.tables[table.name];
    const incoming = Array.isArray(rows) ? rows.length : 0;
    const current = Number((await dbGet(env, `SELECT COUNT(*) AS n FROM ${table.name}`)).n) || 0;
    summary[table.name] = { incoming, current };
  }
  return summary;
}

// 只写 D1。这里不调用任何 Telegram / R2 接口，恢复过程不会改动或删除原文件。
export async function restoreBackup(env, backup, { mode = 'replace' } = {}) {
  const statements = [];
  if (mode === 'replace') {
    for (const table of BACKUP_TABLES) statements.push(env.DB.prepare(`DELETE FROM ${table.name}`));
  }

  const restored = {};
  for (const table of BACKUP_TABLES) {
    const rows = Array.isArray(backup.tables[table.name]) ? backup.tables[table.name] : [];
    restored[table.name] = rows.length;
    for (const row of rows) {
      const columns = table.columns.filter((column) => row[column] !== undefined);
      if (!columns.length) continue;
      const placeholders = columns.map(() => '?').join(', ');
      statements.push(
        env.DB.prepare(
          `INSERT OR REPLACE INTO ${table.name} (${columns.join(', ')}) VALUES (${placeholders})`
        ).bind(...columns.map((column) => row[column]))
      );
    }
  }

  for (let i = 0; i < statements.length; i += BATCH_SIZE) {
    await env.DB.batch(statements.slice(i, i + BATCH_SIZE));
  }
  return { mode, restored };
}
