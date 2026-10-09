ALTER TABLE ai_classifications ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;

-- 旧失败记录已经消耗过额度，默认视为达到上限，避免部署后被重复点击再次调用。
UPDATE ai_classifications SET attempts = 2 WHERE status = 'failed' AND attempts = 0;
