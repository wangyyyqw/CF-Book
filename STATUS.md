# 项目状态

- 项目支持 Cloudflare Pages、D1、R2 与 Telegram Bot 存储的私人书库，包含账号、书目管理、分块上传下载、标准标签、AI 分类、自定义书架和标签库管理。
- 标准标签库结构为 5 个维度；线上库当前 700 个标签、647 个从未使用。
- EPUB 封面提取支持 OPF 相对路径、编码路径及 `../` 归一化；本地全量测试 120 项通过。
- AI 支持 Workers AI、OpenAI-compatible 与 Anthropic Messages；密钥加密保存在服务端存储中，不写入仓库。
- D1 备份含书目、账号、标签、评分、状态与 Telegram 分块索引；恢复只重建 D1，不触碰 Telegram 原文件。

## 一、架构健康度

- 模块总数：上传、下载、书库、书架、账号、书籍元数据、标准标签、标签库管理与 AI 分类 9 个主要模块。
- 违规跨模块调用：本次未发现；书架与标准标签保持独立，权限判定集中在 `functions/utils/shelves.js` 与 `functions/utils/tag-admin.js`。

## 二、变更影响范围

- 本会话完成 7 项功能，逐项提交并推送 `origin/main`，每项完成后部署到 Cloudflare Pages：
  - `5d491ea` 下载改为流式写入（File System Access API → OPFS → Blob 回退）并升级下载中心（队列、并发数、暂停/继续、重试、速度、剩余时间、关闭提醒、历史）。
  - `783250d` 上传任务中心：任务列表、暂停/继续、取消单本、失败分块重试、已上传/剩余/速度、IndexedDB 刷新恢复、长期失效任务清理、上传后自动校验 Telegram 分块。
  - `8c799a9` 批量导入报告：成功/失败/缺少封面/元数据不完整计数与筛选。
  - `de3bb53`、`8f4cae0` D1 自动备份与恢复：加密导出、cron Worker 定时导出、恢复前预览数据量、只恢复数据库。
  - `d81bd0f` 自定义书架：`shelves` / `shelf_books` 表与迁移 `0014`，共享/个人书架、书库书架筛选、详情页加入书架。
  - `6731c9b` 标签库管理页：新增/停用/编辑/合并/删除标签、别名、使用数量、导入导出 JSON、只看从未使用。
- 新增文件：`public/{format,download-stream,download-core,download-queue,upload-store,upload-manager,import-report,tags}.js`、`public/tags.html`、`functions/utils/{concurrency,backup,shelves,tag-admin}.js`、`functions/api/backup/*`、`functions/api/upload/{cleanup.js,[uploadId]/verify.js}`、`functions/api/shelves*`、`functions/api/tags/admin*`、`workers/backup-cron/*`、迁移 `0013`、`0014`。
- 接口契约新增：`/api/backup/{export,preview,restore}`、`/api/upload/cleanup`、`/api/upload/:id/verify`、`/api/shelves*`、`/api/tags/admin*`；`/api/books` 增加 `shelf` 筛选参数，`/api/books/:id` 增加 `shelf_ids` 字段。既有接口语义未改变。
- 迁移状态：线上已执行到 `0014_shelves.sql`；`schema.sql` 已同步 `shelves` / `shelf_books`。

## 三、已知风险

- 公开书目匹配与 AI 标签可能不准确，需人工复核；标签合并/删除是管理员操作，误操作会改变已分类书籍，页面已加二次确认。
- 备份恢复是整表覆盖式写入，恢复到旧快照会丢失之后的改动；备份文件依赖 `BACKUP_KEY`，密钥丢失则无法解密。
- OPFS 与文件系统访问 API 依赖浏览器能力，Safari/移动端会回退到 Blob 合并，超大文件仍受内存限制。
- 上传任务状态存于浏览器 IndexedDB，清理浏览器数据会丢失任务记录（服务端未完成分块仍在）。

## 四、下次最该做的事

- 为备份增加恢复演练记录与定期校验（例如每月抽样解密一次备份）。
- 观察 OPFS/文件系统写入在移动端的实际表现，必要时为大文件下载补充后台任务。
- 按需清理线上 647 个从未使用的标准标签，或先用“合并重复标签”收敛。
