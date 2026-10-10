import { json, err } from '../utils/http.js';
import { dbGet, dbRun, nowSec } from '../utils/db.js';
import { cleanShelfName, listShelves, normalizeScope } from '../utils/shelves.js';

export async function onRequestGet(context) {
  const shelves = await listShelves(context.env, context.data.user);
  return json({ ok: true, shelves });
}

// 共享书架只有管理员能建，个人书架任何账号都能建
export async function onRequestPost(context) {
  const { request, env } = context;
  const user = context.data.user;
  const body = await request.json().catch(() => null);
  if (!body) return err('请求体必须是 JSON');

  const name = cleanShelfName(body.name);
  if (!name) return err('书架名称不能为空');
  const scope = normalizeScope(body.scope);
  if (scope === 'shared' && user.role !== 'admin') return err('只有管理员可以创建共享书架', 403);

  const owner = scope === 'personal' ? user.username : '';
  const existing = await dbGet(
    env,
    'SELECT id FROM shelves WHERE scope = ? AND owner = ? AND name = ?',
    scope,
    owner,
    name
  );
  if (existing) return err('同名书架已存在');

  const id = crypto.randomUUID();
  const now = nowSec();
  const description = String(body.description || '').trim().slice(0, 200);
  await dbRun(
    env,
    `INSERT INTO shelves (id, name, description, scope, owner, created_by, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    name,
    description,
    scope,
    owner,
    user.username,
    0,
    now,
    now
  );
  return json({ ok: true, shelf: { id, name, description, scope, owner, book_count: 0 } });
}
