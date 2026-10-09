-- CF-Book 原型数据库结构（Cloudflare D1 / SQLite）
CREATE TABLE IF NOT EXISTS uploads (
  upload_id    TEXT PRIMARY KEY,
  filename     TEXT NOT NULL,
  mime         TEXT NOT NULL DEFAULT 'application/octet-stream',
  total_size   INTEGER NOT NULL,
  chunk_size   INTEGER NOT NULL DEFAULT 8388608,
  total_chunks INTEGER NOT NULL,
  sha256       TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'active',
  owner        TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
  upload_id     TEXT NOT NULL,
  idx           INTEGER NOT NULL,
  size          INTEGER NOT NULL DEFAULT 0,
  sha256        TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'pending',
  tg_chat_id    TEXT NOT NULL DEFAULT '',
  tg_message_id INTEGER,
  tg_file_id    TEXT NOT NULL DEFAULT '',
  error         TEXT NOT NULL DEFAULT '',
  retries       INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (upload_id, idx)
);

CREATE INDEX IF NOT EXISTS idx_chunks_upload ON chunks(upload_id);
CREATE INDEX IF NOT EXISTS idx_uploads_status ON uploads(status);

-- 书籍元数据
CREATE TABLE IF NOT EXISTS books (
  id          TEXT PRIMARY KEY,
  upload_id   TEXT UNIQUE,
  title       TEXT NOT NULL DEFAULT '',
  author      TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  cover       TEXT NOT NULL DEFAULT '',
  format      TEXT NOT NULL DEFAULT '',
  isbn        TEXT NOT NULL DEFAULT '',
  publisher   TEXT NOT NULL DEFAULT '',
  language    TEXT NOT NULL DEFAULT '',
  file_name   TEXT NOT NULL DEFAULT '',
  file_size   INTEGER NOT NULL DEFAULT 0,
  sha256      TEXT NOT NULL DEFAULT '',
  created_by  TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_books_title ON books(title);
CREATE INDEX IF NOT EXISTS idx_books_author ON books(author);
CREATE INDEX IF NOT EXISTS idx_books_created ON books(created_at DESC);

-- 每个账号各自的评分与阅读状态
CREATE TABLE IF NOT EXISTS book_user_state (
  book_id      TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  rating       REAL NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'unread',
  is_favorite  INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (book_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_bus_book ON book_user_state(book_id);
CREATE INDEX IF NOT EXISTS idx_bus_user ON book_user_state(user_id);

CREATE TABLE IF NOT EXISTS tags (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL DEFAULT 'other'
);

CREATE TABLE IF NOT EXISTS book_tags (
  book_id TEXT NOT NULL,
  tag_id  INTEGER NOT NULL,
  PRIMARY KEY (book_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_book_tags_book ON book_tags(book_id);
CREATE INDEX IF NOT EXISTS idx_book_tags_tag ON book_tags(tag_id);

-- AI 书名清理与标签分类记录
CREATE TABLE IF NOT EXISTS ai_classifications (
  book_id       TEXT PRIMARY KEY,
  status        TEXT NOT NULL DEFAULT 'pending',
  attempts      INTEGER NOT NULL DEFAULT 0,
  cleaned_title TEXT NOT NULL DEFAULT '',
  tags_json     TEXT NOT NULL DEFAULT '[]',
  source        TEXT NOT NULL DEFAULT '',
  error         TEXT NOT NULL DEFAULT '',
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_usage (
  id                TEXT PRIMARY KEY,
  book_id           TEXT,
  model             TEXT NOT NULL,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  neurons           REAL NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'completed',
  error             TEXT NOT NULL DEFAULT '',
  created_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage(created_at);
CREATE INDEX IF NOT EXISTS idx_ai_classifications_status ON ai_classifications(status);

-- NVIDIA 兼容模型配置；密钥以 AES-GCM 密文保存，轮换游标用于均匀轮询。
CREATE TABLE IF NOT EXISTS nvidia_ai_config (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  model          TEXT NOT NULL DEFAULT 'deepseek-ai/deepseek-v4-pro',
  encrypted_keys TEXT NOT NULL DEFAULT '[]',
  next_key       INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL DEFAULT 0
);

-- 账号
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member',
  disabled      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
