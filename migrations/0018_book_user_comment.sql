-- 个人评论/笔记：为每人每本的阅读状态增加评论列（上限由应用层限制为 500 字）。
-- 已存在该列时请跳过本迁移，不要重复执行。

ALTER TABLE book_user_state ADD COLUMN comment TEXT NOT NULL DEFAULT '';
