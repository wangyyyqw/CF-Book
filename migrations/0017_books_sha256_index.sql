-- 为按内容哈希查重建立索引，支撑上传完成时的"疑似重复"提示。
-- 已存在该索引时跳过本迁移，不要重复执行。

CREATE INDEX IF NOT EXISTS idx_books_sha256 ON books(sha256);
