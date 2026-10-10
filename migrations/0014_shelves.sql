-- 自定义书架：与标准标签分开的个人/共享整理方式。
-- 已存在这些表时跳过本迁移，不要重复执行。

CREATE TABLE IF NOT EXISTS shelves (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  scope       TEXT NOT NULL DEFAULT 'shared',
  owner       TEXT NOT NULL DEFAULT '',
  created_by  TEXT NOT NULL DEFAULT '',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_shelves_scope_owner_name ON shelves(scope, owner, name);

CREATE TABLE IF NOT EXISTS shelf_books (
  shelf_id TEXT NOT NULL,
  book_id  TEXT NOT NULL,
  added_by TEXT NOT NULL DEFAULT '',
  added_at INTEGER NOT NULL,
  PRIMARY KEY (shelf_id, book_id)
);

CREATE INDEX IF NOT EXISTS idx_shelf_books_book ON shelf_books(book_id);
