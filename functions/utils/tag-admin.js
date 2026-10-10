import { dbAll, dbGet, dbRun } from './db.js';

const TAG_ID_PREFIX = {
  book_type: 'BOOK_TYPE',
  pub_field: 'PUB_FIELD',
  pub_topic: 'PUB_TOPIC',
  web_genre: 'WEB_GENRE',
  web_element: 'WEB_ELEMENT',
};

export const MAX_TAG_NAME = 40;
export const MAX_TAG_TEXT = 300;

export function cleanText(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

// 别名支持逗号、分号或换行分隔，去空去重后最多保留 20 个
export function cleanAliases(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[\n,，;；]/);
  const seen = new Set();
  const result = [];
  for (const item of list) {
    const alias = cleanText(item, MAX_TAG_NAME);
    if (!alias || seen.has(alias)) continue;
    seen.add(alias);
    result.push(alias);
    if (result.length >= 20) break;
  }
  return result;
}

export async function listTagLibrary(env) {
  const dimensions = await dbAll(env, 'SELECT dimension, name_zh, description FROM tag_dimensions ORDER BY rowid');
  const tags = await dbAll(
    env,
    `SELECT tag_id, name, dimension, category, parent_id, description, status
       FROM standard_tags ORDER BY dimension, category, name`
  );
  const counts = await dbAll(env, 'SELECT tag_id, COUNT(*) AS n FROM book_standard_tags GROUP BY tag_id');
  const countById = new Map(counts.map((row) => [row.tag_id, Number(row.n) || 0]));
  const aliases = await dbAll(env, 'SELECT tag_id, alias FROM standard_tag_aliases ORDER BY alias');
  const aliasById = new Map();
  for (const row of aliases) {
    if (!aliasById.has(row.tag_id)) aliasById.set(row.tag_id, []);
    aliasById.get(row.tag_id).push(row.alias);
  }
  return {
    dimensions,
    tags: tags.map((tag) => ({
      ...tag,
      usage_count: countById.get(tag.tag_id) || 0,
      aliases: aliasById.get(tag.tag_id) || [],
    })),
  };
}

async function replaceAliases(env, tagId, aliases) {
  await dbRun(env, 'DELETE FROM standard_tag_aliases WHERE tag_id = ?', tagId);
  for (const alias of aliases) {
    await dbRun(env, 'INSERT OR IGNORE INTO standard_tag_aliases (tag_id, alias) VALUES (?, ?)', tagId, alias);
  }
}

async function nextTagId(env, dimension) {
  const prefix = TAG_ID_PREFIX[dimension];
  if (!prefix) return `${dimension.toUpperCase()}_${Date.now()}`;
  const row = await dbGet(
    env,
    'SELECT tag_id FROM standard_tags WHERE tag_id LIKE ? ORDER BY tag_id DESC LIMIT 1',
    `${prefix}_%`
  );
  const current = row ? Number(String(row.tag_id).slice(prefix.length + 1)) : 0;
  return `${prefix}_${String((Number.isFinite(current) ? current : 0) + 1).padStart(4, '0')}`;
}

async function validParent(env, parentId, selfId = '') {
  if (!parentId) return { parentId: null };
  if (parentId === selfId) return { error: '标签不能把自己设成父标签' };
  const parent = await dbGet(env, 'SELECT tag_id FROM standard_tags WHERE tag_id = ?', parentId);
  if (!parent) return { error: '父标签不存在' };
  return { parentId };
}

export async function createTag(env, payload = {}) {
  const name = cleanText(payload.name, MAX_TAG_NAME);
  if (!name) return { error: '标签名称不能为空' };
  const dimension = cleanText(payload.dimension, 40);
  const dimensionRow = await dbGet(env, 'SELECT dimension FROM tag_dimensions WHERE dimension = ?', dimension);
  if (!dimensionRow) return { error: '标签维度不存在' };

  const duplicate = await dbGet(
    env,
    'SELECT tag_id FROM standard_tags WHERE dimension = ? AND name = ?',
    dimension,
    name
  );
  if (duplicate) return { error: '该维度下已有同名标签' };

  const parent = await validParent(env, cleanText(payload.parent_id, 40));
  if (parent.error) return { error: parent.error };

  const tagId = await nextTagId(env, dimension);
  const category = cleanText(payload.category, MAX_TAG_NAME) || '其他';
  const description = cleanText(payload.description, MAX_TAG_TEXT);
  await dbRun(
    env,
    `INSERT INTO standard_tags (tag_id, name, dimension, category, parent_id, description, status)
     VALUES (?, ?, ?, ?, ?, ?, 'active')`,
    tagId,
    name,
    dimension,
    category,
    parent.parentId,
    description
  );
  const aliases = cleanAliases(payload.aliases);
  await replaceAliases(env, tagId, aliases);
  return { tag: { tag_id: tagId, name, dimension, category, parent_id: parent.parentId, description, status: 'active', aliases } };
}

export async function updateTag(env, tagId, payload = {}) {
  const tag = await dbGet(env, 'SELECT * FROM standard_tags WHERE tag_id = ?', tagId);
  if (!tag) return { error: '标签不存在', status: 404 };

  const name = payload.name == null ? tag.name : cleanText(payload.name, MAX_TAG_NAME);
  if (!name) return { error: '标签名称不能为空' };
  const duplicate = await dbGet(
    env,
    'SELECT tag_id FROM standard_tags WHERE dimension = ? AND name = ? AND tag_id != ?',
    tag.dimension,
    name,
    tagId
  );
  if (duplicate) return { error: '该维度下已有同名标签' };

  const parent = payload.parent_id === undefined
    ? { parentId: tag.parent_id }
    : await validParent(env, cleanText(payload.parent_id, 40), tagId);
  if (parent.error) return { error: parent.error };

  const category = payload.category == null ? tag.category : cleanText(payload.category, MAX_TAG_NAME);
  const description = payload.description == null ? tag.description : cleanText(payload.description, MAX_TAG_TEXT);
  const status = payload.status == null ? tag.status : (payload.status === 'disabled' ? 'disabled' : 'active');

  await dbRun(
    env,
    'UPDATE standard_tags SET name = ?, category = ?, parent_id = ?, description = ?, status = ? WHERE tag_id = ?',
    name,
    category,
    parent.parentId,
    description,
    status,
    tagId
  );
  if (payload.aliases != null) await replaceAliases(env, tagId, cleanAliases(payload.aliases));
  return { tag: { ...tag, name, category, parent_id: parent.parentId, description, status } };
}

export async function deleteTag(env, tagId) {
  const tag = await dbGet(env, 'SELECT tag_id FROM standard_tags WHERE tag_id = ?', tagId);
  if (!tag) return { error: '标签不存在', status: 404 };
  const used = await dbGet(env, 'SELECT COUNT(*) AS n FROM book_standard_tags WHERE tag_id = ?', tagId);
  await dbRun(env, 'DELETE FROM book_standard_tags WHERE tag_id = ?', tagId);
  await dbRun(env, 'DELETE FROM standard_tag_aliases WHERE tag_id = ?', tagId);
  await dbRun(env, 'UPDATE standard_tags SET parent_id = NULL WHERE parent_id = ?', tagId);
  await dbRun(env, 'DELETE FROM standard_tags WHERE tag_id = ?', tagId);
  return { removed_links: Number(used.n) || 0 };
}

// 把 from 合并进 to：书籍关联、别名与子标签全部转移，再删除源标签。
// 只允许同维度合并，避免破坏“类型 + 领域/题材 + 主题/设定”的结构。
export async function mergeTags(env, fromId, toId) {
  if (!fromId || !toId) return { error: '请选择要合并的标签' };
  if (fromId === toId) return { error: '不能把标签合并到它自己' };
  const from = await dbGet(env, 'SELECT * FROM standard_tags WHERE tag_id = ?', fromId);
  const to = await dbGet(env, 'SELECT * FROM standard_tags WHERE tag_id = ?', toId);
  if (!from) return { error: '源标签不存在', status: 404 };
  if (!to) return { error: '目标标签不存在', status: 404 };
  if (from.dimension !== to.dimension) return { error: '只能合并同一维度下的标签' };

  const before = await dbGet(env, 'SELECT COUNT(*) AS n FROM book_standard_tags WHERE tag_id = ?', fromId);
  await dbRun(
    env,
    `INSERT OR IGNORE INTO book_standard_tags (book_id, tag_id)
     SELECT book_id, ? FROM book_standard_tags WHERE tag_id = ?`,
    toId,
    fromId
  );
  await dbRun(env, 'DELETE FROM book_standard_tags WHERE tag_id = ?', fromId);
  await dbRun(
    env,
    `INSERT OR IGNORE INTO standard_tag_aliases (tag_id, alias)
     SELECT ?, alias FROM standard_tag_aliases WHERE tag_id = ?`,
    toId,
    fromId
  );
  await dbRun(env, 'DELETE FROM standard_tag_aliases WHERE tag_id = ?', fromId);
  // 源标签名本身也留作别名，避免以后又被当成新标签建出来
  await dbRun(env, 'INSERT OR IGNORE INTO standard_tag_aliases (tag_id, alias) VALUES (?, ?)', toId, from.name);
  await dbRun(env, 'UPDATE standard_tags SET parent_id = ? WHERE parent_id = ?', toId, fromId);
  await dbRun(env, 'DELETE FROM standard_tags WHERE tag_id = ?', fromId);
  return { merged_books: Number(before.n) || 0, from: from.name, to: to.name };
}

// 导入 JSON：按 tag_id 或“维度 + 名称”匹配已有标签，其余新建。
export async function importTags(env, payload = {}) {
  const list = Array.isArray(payload.tags) ? payload.tags : [];
  if (!list.length) return { error: '导入内容里没有 tags 数组' };
  const result = { created: 0, updated: 0, skipped: [] };
  for (const item of list) {
    const name = cleanText(item?.name, MAX_TAG_NAME);
    if (!name) {
      result.skipped.push('（缺少名称）');
      continue;
    }
    const dimension = cleanText(item.dimension, 40);
    const existing = item.tag_id
      ? await dbGet(env, 'SELECT tag_id FROM standard_tags WHERE tag_id = ?', item.tag_id)
      : await dbGet(env, 'SELECT tag_id FROM standard_tags WHERE dimension = ? AND name = ?', dimension, name);
    if (existing) {
      await updateTag(env, existing.tag_id, {
        name,
        category: item.category,
        description: item.description,
        status: item.status,
        parent_id: item.parent_id,
        aliases: item.aliases,
      });
      result.updated += 1;
      continue;
    }
    const created = await createTag(env, item);
    if (created.error) {
      result.skipped.push(`${name}：${created.error}`);
      continue;
    }
    result.created += 1;
  }
  return result;
}
