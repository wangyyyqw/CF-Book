CREATE TABLE IF NOT EXISTS nvidia_ai_config (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  model          TEXT NOT NULL DEFAULT 'deepseek-ai/deepseek-v4-pro',
  encrypted_keys TEXT NOT NULL DEFAULT '[]',
  next_key       INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL DEFAULT 0
);
