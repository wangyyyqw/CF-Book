export const BOOK_STATUSES = ['unread', 'reading', 'read'];
export const DEFAULT_STATUS = 'unread';
export const MAX_TAGS = 30;
export const MAX_TAG_LENGTH = 32;
export const MAX_COMMENT_LENGTH = 500;

// 评分统一为 0–10，保留一位小数；非法输入回落到 0
export function normalizeRating(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  const clamped = Math.min(Math.max(num, 0), 10);
  return Math.round(clamped * 10) / 10;
}

export function normalizeStatus(value) {
  return BOOK_STATUSES.includes(value) ? value : DEFAULT_STATUS;
}

export function normalizeFavorite(value) {
  return value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0;
}

// 个人评论/笔记：去除首尾空白并截断到上限，非字符串回落为空串
export function normalizeComment(value) {
  if (value == null) return '';
  return String(value).trim().slice(0, MAX_COMMENT_LENGTH);
}

// 清洗标签：去空、去重，并限制数量与长度
export function parseTags(raw) {
  const list = Array.isArray(raw) ? raw.map((t) => String(t).trim()).filter(Boolean) : [];
  const unique = [...new Set(list)];
  if (unique.length > MAX_TAGS) return { error: `标签最多 ${MAX_TAGS} 个` };
  if (unique.some((t) => t.length > MAX_TAG_LENGTH)) {
    return { error: `单个标签不能超过 ${MAX_TAG_LENGTH} 个字符` };
  }
  return { tags: unique };
}
