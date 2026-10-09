CREATE TABLE IF NOT EXISTS ai_provider_config (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  format         TEXT NOT NULL DEFAULT 'openai',
  base_url       TEXT NOT NULL DEFAULT '',
  model          TEXT NOT NULL DEFAULT '',
  encrypted_key  TEXT NOT NULL DEFAULT '',
  updated_at     INTEGER NOT NULL DEFAULT 0
);
