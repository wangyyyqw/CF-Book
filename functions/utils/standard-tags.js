import { dbAll, dbGet, dbRun } from './db.js';

const BOOK_TYPE_DIMENSION = 'book_type';
const PUB_DIMENSIONS = ['pub_field', 'pub_topic'];
const WEB_DIMENSIONS = ['web_genre', 'web_element'];

export async function getTagCandidates(env) {
  return dbAll(
    env,
    `SELECT tag_id, name, dimension, category, description FROM standard_tags
     WHERE status='active' ORDER BY dimension, category, name`
  );
}

export function normalizeStandardTagResult(text, bookId) {
  const result = parseJson(text, bookId);
  const typeName = result.book_type;
  const expectedType = typeName === '出版书' ? 'BOOK_TYPE_0001' : typeName === '网文' ? 'BOOK_TYPE_0002' : '';
  const ids = result.tag_ids;
  if (result.book_id !== bookId || result.needs_review !== false || !expectedType ||
      !Array.isArray(ids) || ids.length !== 3 || new Set(ids).size !== 3 || ids[0] !== expectedType) {
    throw new Error(result.review_reason || 'AI 返回的标准标签结果不完整或需要人工审核');
  }
  const dimensions = typeName === '出版书' ? PUB_DIMENSIONS : WEB_DIMENSIONS;
  const confidence = result.confidence;
  if (!confidence || !['book_type', 'tag_2', 'tag_3'].every((key) =>
    Number.isFinite(Number(confidence[key])) && Number(confidence[key]) >= 0 && Number(confidence[key]) <= 1)) {
    throw new Error('AI 标准标签 confidence 必须为 0 到 1 之间的数值');
  }
  return { bookId, bookType: typeName, tagIds: ids, dimensions, evidence: result.evidence || [] };
}

export async function validateStandardTagIds(env, result) {
  const rows = await dbAll(
    env,
    `SELECT tag_id, dimension FROM standard_tags WHERE status='active' AND tag_id IN (?, ?, ?)`,
    ...result.tagIds
  );
  const byId = new Map(rows.map((row) => [row.tag_id, row.dimension]));
  return byId.size === 3 && byId.get(result.tagIds[0]) === BOOK_TYPE_DIMENSION &&
    byId.get(result.tagIds[1]) === result.dimensions[0] && byId.get(result.tagIds[2]) === result.dimensions[1];
}

export async function validateTagIdList(env, tagIds) {
  if (!Array.isArray(tagIds) || tagIds.length !== 3 || new Set(tagIds).size !== 3) {
    return { error: '必须选择 3 个互不重复的标准标签' };
  }
  const rows = await dbAll(
    env,
    'SELECT tag_id, dimension FROM standard_tags WHERE status=\'active\' AND tag_id IN (?, ?, ?)',
    ...tagIds
  );
  const byId = new Map(rows.map((row) => [row.tag_id, row.dimension]));
  const type = byId.get(tagIds[0]);
  const expected = type === 'book_type' && tagIds[0] === 'BOOK_TYPE_0001'
    ? ['pub_field', 'pub_topic']
    : type === 'book_type' && tagIds[0] === 'BOOK_TYPE_0002'
      ? ['web_genre', 'web_element']
      : null;
  if (!expected || byId.get(tagIds[1]) !== expected[0] || byId.get(tagIds[2]) !== expected[1]) {
    return { error: '标签必须按“书籍类型 + 对应领域/题材 + 主题/设定”的维度顺序选择' };
  }
  return { tagIds, dimensions: expected };
}

export async function replaceStandardTags(env, bookId, tagIds) {
  await dbRun(env, 'DELETE FROM book_standard_tags WHERE book_id=?', bookId);
  for (const tagId of tagIds) {
    await dbRun(env, 'INSERT INTO book_standard_tags (book_id, tag_id) VALUES (?, ?)', bookId, tagId);
  }
}

export async function standardTagDetails(env, bookId) {
  return dbAll(
    env,
    `SELECT t.tag_id, t.name, t.dimension, t.category, t.description
       FROM book_standard_tags bt JOIN standard_tags t ON t.tag_id=bt.tag_id
      WHERE bt.book_id=? ORDER BY CASE t.dimension
        WHEN 'book_type' THEN 0 WHEN 'pub_field' THEN 1 WHEN 'web_genre' THEN 1
        WHEN 'pub_topic' THEN 2 WHEN 'web_element' THEN 2 ELSE 3 END, t.category, t.name`,
    bookId
  );
}

export async function listStandardTagDimensions(env) {
  const dimensions = await dbAll(env, 'SELECT dimension, name_zh, description FROM tag_dimensions ORDER BY rowid');
  const tags = await dbAll(env, `SELECT tag_id, name, dimension, category, description
    FROM standard_tags WHERE status='active' ORDER BY dimension, category, name`);
  const counts = await dbAll(env, `SELECT tag_id, COUNT(book_id) AS count FROM book_standard_tags GROUP BY tag_id`);
  const countById = new Map(counts.map((row) => [row.tag_id, Number(row.count)]));
  const populatedDimensions = dimensions.map((dimension) => ({
    ...dimension,
    tags: tags.filter((tag) => tag.dimension === dimension.dimension)
      .map((tag) => ({ ...tag, count: countById.get(tag.tag_id) || 0 })),
  })).map((dimension) => ({
    ...dimension,
    tags: dimension.tags.filter((tag) => tag.count > 0),
  })).filter((dimension) => dimension.tags.length > 0);
  return {
    dimensions: populatedDimensions,
    untaggedCount: Number((await dbGet(
      env,
      `SELECT COUNT(*) AS count FROM books b
       WHERE NOT EXISTS (SELECT 1 FROM book_standard_tags bt WHERE bt.book_id = b.id)`
    )).count || 0),
  };
}

export async function getTagNames(env, tagIds) {
  if (!tagIds.length) return [];
  const marks = tagIds.map(() => '?').join(',');
  return dbAll(env, `SELECT tag_id, name FROM standard_tags WHERE tag_id IN (${marks})`, ...tagIds);
}

function parseJson(value, bookId) {
  const text = String(value || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    return JSON.parse(text);
  } catch {
    const candidates = [];
    for (let start = 0; start < text.length; start += 1) {
      if (text[start] !== '{') continue;
      let depth = 0;
      let quoted = false;
      let escaped = false;
      for (let end = start; end < text.length; end += 1) {
        const char = text[end];
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') quoted = false;
          continue;
        }
        if (char === '"') quoted = true;
        else if (char === '{') depth += 1;
        else if (char === '}' && --depth === 0) {
          candidates.push(text.slice(start, end + 1));
          break;
        }
      }
    }
    for (const candidate of candidates.reverse()) {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed?.book_id === bookId && Array.isArray(parsed.tag_ids)) return parsed;
      } catch {
        // Skip unrelated JSON examples embedded in model reasoning.
      }
    }
    throw new Error('AI 标准标签 JSON 无法解析');
  }
}
