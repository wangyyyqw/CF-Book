import { dbAll } from './db.js';

export const SHELF_SCOPES = ['shared', 'personal'];
export const MAX_SHELF_NAME = 24;

export function normalizeScope(value) {
  return value === 'personal' ? 'personal' : 'shared';
}

export function cleanShelfName(value) {
  return String(value || '').trim().slice(0, MAX_SHELF_NAME);
}

// 可见性与 listShelves 保持一致：共享书架所有人可见，个人书架只有本人可见。
export function canViewShelf(user, shelf) {
  if (!user) return false;
  if (shelf.scope === 'personal') return shelf.owner === user.username;
  return true;
}

// 权限与可见性一致：共享书架对所有登录账号开放整理（与标准标签一致），
// 个人书架只属于本人，连管理员也不越权。
export function canEditBooks(user, shelf) {
  if (!user) return false;
  if (shelf.scope === 'personal') return shelf.owner === user.username;
  return true;
}

// 改名与删除属于书架本身的管理：个人书架归本人，共享书架只有管理员能动。
export function canManageShelf(user, shelf) {
  if (!user) return false;
  if (shelf.scope === 'personal') return shelf.owner === user.username;
  return user.role === 'admin';
}

export async function listShelves(env, user) {
  return dbAll(
    env,
    `SELECT s.*,
       (SELECT COUNT(*) FROM shelf_books sb WHERE sb.shelf_id = s.id) AS book_count
     FROM shelves s
     WHERE s.scope = 'shared' OR (s.scope = 'personal' AND s.owner = ?)
     ORDER BY s.scope = 'personal', s.sort_order, s.created_at, s.name`,
    user.username
  );
}
