-- 上传任务中心：记录每次 Telegram 分块校验的结果，供上传页展示。
-- 已存在该列时跳过本迁移，不要重复执行。

ALTER TABLE uploads ADD COLUMN verified_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE uploads ADD COLUMN verify_result TEXT NOT NULL DEFAULT '';
