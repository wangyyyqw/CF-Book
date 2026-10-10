import { json, err } from '../../utils/http.js';
import { dbGet, dbRun, nowSec } from '../../utils/db.js';
import { canManageShelf, cleanShelfName } from '../../utils/shelves.js';

export async function onRequestPut(context) {
  const { request, env, params } = context;
  const shelf = await dbGet(env, 'SELECT * FROM shelves WHERE id = ?', params.id);
  if (!shelf) return err('书架不存在', 404);
  if (!canManageShelf(context.data.user, shelf)) return err('没有权限修改这个书架', 403);

  const body = await request.json().catch(() => null);
  if (!body) return err('请求体必须是 JSON');

  const name = body.name == null ? shelf.name : cleanShelfName(body.name);
  if (!name) return err('书架名称不能为空');
  const description = body.description == null
    ? shelf.description
    : String(body.description).trim().slice(0, 200);

  const clash = await dbGet(
    env,
    'SELECT id FROM shelves WHERE scope = ? AND owner = ? AND name = ? AND id != ?',
    shelf.scope,
    shelf.owner,
    name,
    shelf.id
  );
  if (clash) return err('同名书架已存在');

  await dbRun(
    env,
    'UPDATE shelves SET name = ?, description = ?, updated_at = ? WHERE id = ?',
    name,
    description,
    nowSec(),
    shelf.id
  );
  return json({ ok: true, shelf: { ...shelf, name, description } });
}

export async function onRequestDelete(context) {
  const { env, params } = context;
  const shelf = await dbGet(env, 'SELECT * FROM shelves WHERE id = ?', params.id);
  if (!shelf) return err('书架不存在', 404);
  if (!canManageShelf(context.data.user, shelf)) return err('没有权限删除这个书架', 403);

  // 只删书架与它的成员关系，书籍本身不动
  await dbRun(env, 'DELETE FROM shelf_books WHERE shelf_id = ?', shelf.id);
  await dbRun(env, 'DELETE FROM shelves WHERE id = ?', shelf.id);
  return json({ ok: true });
}
