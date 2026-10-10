-- 记录书名已由 AI 清洗的时间，避免批量清洗重复消耗额度。
ALTER TABLE books ADD COLUMN title_cleaned_at INTEGER NOT NULL DEFAULT 0;
