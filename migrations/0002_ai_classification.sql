CREATE TABLE IF NOT EXISTS ai_classifications (
  book_id       TEXT PRIMARY KEY,
  status        TEXT NOT NULL DEFAULT 'pending',
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
