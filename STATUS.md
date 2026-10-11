# 项目状态

- 项目支持 Cloudflare Pages、D1、R2 与 Telegram Bot 存储的私人书库，包含账号、书目管理、分块上传下载、标准标签、AI 分类、自定义书架和标签库管理。
- 标准标签库结构为 5 个维度；上一轮线上核对为 700 个标签、647 个从未使用，本次请求优化不读取生产书目或账号内容。
- EPUB 封面提取支持 OPF 相对路径、编码路径及 `../` 归一化；本次本地全量测试 120 项通过，界面验收 460 项通过。
- MOBI/AZW3 导入按 PDB 记录目录精读元数据和封面，支持 EXTH 中文书名、KF8 双格式、UTF-8/Windows-1252、DRM 提示与上传任务告警；本次本地全量测试 137 项通过。尚未对生产中的异常书目执行写入修复。
- 本次请求优化后的本地全量测试 142 项通过，响应式验收 460/460 项通过；书库首屏使用共享认证、合并分面、紧凑书目响应和可取消请求。
- 本次新增上传后 AI 书名清洗，全量测试 148 项通过；清洗只更新 D1 书名，不触碰 Telegram 分块索引与 R2 封面。
- 本次新增现有图书批量书名清洗，全量测试 152 项通过；只更新 D1 书名与清洗标记，不触碰 Telegram 分块索引与 R2 封面。随后修复推理型模型输出被截断导致的清洗失败，并增加上游抖动退避重跑、修复分批跳书，全量测试 160 项通过。
- AI 支持 Workers AI、OpenAI-compatible 与 Anthropic Messages；密钥加密保存在服务端存储中，不写入仓库。
- D1 备份含书目、账号、标签、评分、状态与 Telegram 分块索引；恢复只重建 D1，不触碰 Telegram 原文件。
- 本次（2026-10-11）新增 7 项优化中剩余 4 项并逐项推送 `origin/main`：登录失败限流（`cf60c6b`）、按内容哈希提示疑似重复（`79ef6fd`）此前已完成；本次完成书库多字段排序（`c6fe219`）、书库统计面板（`fe19bb2`）、个人评论/笔记（`9688e78`）、单人默认隐藏多人视图（`8bd1e9f`），并补响应式验收数据（`f0786dc`）。全量测试 189 项通过，Playwright 响应式验收 460/460 通过。
- 本次（2026-10-11 续）将书库统计从账号管理页拆成独立页（`4bf45f7`，已推 `origin/main`），并完成一轮 Cloudflare 部署：Pages 重新部署（`de44b37e`）、新建 R2 备份桶 `cf-book-backups`、部署定时备份 Worker `cf-book-backup-cron` 并配置 `ADMIN_TOKEN` secret。全量测试 189 项通过，本机 Playwright 响应式验收 509/509 通过（9 页 × 7 宽）。

## 一、架构健康度

- 模块总数：上传、下载、书库、书架、账号、书籍元数据、标准标签、标签库管理与 AI 分类 9 个主要模块。
- 违规跨模块调用：本次未发现；书架与标准标签保持独立，权限判定集中在 `functions/utils/shelves.js` 与 `functions/utils/tag-admin.js`。
- 本次新增只读聚合接口 `functions/api/library/stats.js`（归入书库模块），复用 `requireAdmin` 与 `formatBytes`，不新增生产依赖；个人评论沿用 `book_user_state`，经 `normalizeComment` 收口，新增迁移 `0018`。
- 本次在既有书库、书架和标准标签模块之间增加读取聚合与短期缓存，沿用现有鉴权、样式和导航，不新增生产依赖或数据库迁移。
- 本次在 AI 分类模块内新增书名清洗能力，沿用同一套自定义 Provider / Workers AI 配置，不新增生产依赖或数据库迁移。
- 本次新增现有图书批量清洗接口与管理页入口，沿用同一套 AI 配置，不新增生产依赖；新增迁移 `0015_title_clean.sql`。

## 二、变更影响范围

- 本次（2026-10-11 续）统计页拆分与 Cloudflare 部署：
  - 统计页拆分（`4bf45f7`）：新增 `public/stats.html`、`public/stats.js` 承载统计总览与分维度列表，仅管理员可见、非管理员提示无权限；`public/nav.js` 在“账号管理”前加“统计”入口；从 `public/users.html`、`public/users.js` 删除统计 panel 及 `loadStats`/`groupTagsByDimension`/`DIMENSION_LABEL` 与无用的 `formatBytes` 导入；`scripts/check-responsive-ui.mjs` 增测 stats 页。接口契约不变，复用既有 `/api/library/stats`。
  - 部署与资源：Pages 重新部署线上生效（`https://de44b37e.cf-book.pages.dev`，主域 `cf-book.pages.dev`）；新建 R2 桶 `cf-book-backups` 存放备份；部署独立定时备份 Worker `cf-book-backup-cron`（`https://cf-book-backup-cron.uycmjfichg.workers.dev`，cron `17 3 * * *` UTC），并用与 Pages 一致的 `ADMIN_TOKEN` 设置 Worker secret。部署时临时回填 `wrangler.toml` 与 `workers/backup-cron/wrangler.toml` 真实值，完成后已 `git checkout --` 还原为公开仓库占位，工作区无残留改动。
  - 验证：`npm test` 189 项全绿；`node --check` 相关 JS 文件通过；本机 Playwright 响应式 509/509 通过（9 页 × 7 宽）。线上 `/stats` 带管理员令牌返回 200 且含统计容器与 `stats.js`，未登录访问 302 跳转 `/login`；`/users` 已不含 `stats-overview`。备份 Worker 手动触发：错误令牌 403、正确令牌 200 并在 R2 生成 `backups/cf-book-backup-2026-10-11T01-42-50-947Z.json`（约 436KB 加密信封，`encrypted:true`，含 55 本书计数）。
- 本次（2026-10-11）增量优化，逐项提交并推送 `origin/main`：
  - 书库多字段排序（`c6fe219`）：`/api/books` 增加 `sort`/`dir` 白名单参数（time/title/author/rating/size，asc/desc），非法键回落 time-desc，recommended 分支仍随机；`public/library.html`/`library.js` 加排序下拉并拆分请求参数，`style.css` 把目录栏栅格由 4 列扩到 5 列并同步 999/470 断点。接口契约向后兼容，默认行为不变。
  - 书库统计面板（`fe19bb2`）：新增 `/api/library/stats`（管理员，私有短缓存）按格式/语言/标准标签统计 `COUNT(*)` 与 `SUM(file_size)`；账号页新增统计面板，总览复用 `report-grid`，分维度用新 `stats-list` 布局，大小用 `formatBytes` 展示。
  - 个人评论/笔记（`9688e78`）：`book_user_state` 加 `comment` 列（schema.sql 同步、迁移 `0018` ALTER、`BACKUP_TABLES` 加入 comment）；`normalizeComment` 去空限 500 字；state PUT upsert 评论、books GET 返回 `my_comment` 并随 ratings 带出他人评论；详情页加评论文本域、字数提示与评论展示。
  - 单人默认隐藏多人视图（`8bd1e9f`）：`/api/auth/me` 返回 `multiUser`（账号数>1）与登录后的 `userCount`；详情页按 `multiUser` 隐藏“大家的打分”整块，书库卡片单人时隐藏平均分徽标，第 2 账号出现后自动恢复。未登录不返回精确账号数。
  - 响应式验收数据（`f0786dc`）：`tests/helpers/ui-fixtures.mjs` 为 me 补 multiUser/userCount、为书籍详情补 my_comment 与多人评论、新增 /api/library/stats 响应，使新界面在 Playwright 检查中真正渲染。
- 验证：`npm test` 从 169→189 项通过（排序 +7、统计 +4、评论 +5、me 接口 +4）；`node --check` 与 `git diff --check` 均无告警；本机临时安装 Playwright+Chromium 跑 `scripts/check-responsive-ui.mjs`，7 个宽度 460/460 通过，截图在被忽略的 `.wrangler/ui-check/`，未改动项目依赖（package.json 保持不变）。

- 本次修复 Kindle 导入：新增 `public/kindle.js`，从正确的 Palm/MOBI 记录解析书名、作者、出版社、简介、ISBN、语言和封面；`public/metadata.js` 接入 `mobi`、`azw`、`azw3`，上传任务显示解析告警并在暂停/刷新后重新提取尚未挂接的封面；不破解 DRM、不覆盖 Telegram 原文件。新增真实布局 fixture 与 17 个 Kindle/EPUB 元数据测试、上传接线回归测试。

- 本次修复滚动触发推荐换书：`public/library.js` 移除窗口尺寸变化时的推荐请求，仅保留页面加载和“换一批”；馆藏分页仍随列数调整，推荐书籍在当前页面内保持不变。不改变接口契约、数据库或 Telegram 原文件。
- 验证：新增推荐稳定性检查，修改前 15 项失败、修改后 460/460 项通过；覆盖滚动及高度变化、横竖屏切换、慢响应加载期间切换宽度、主动换一批和刷新页面。`npm test` 120 项通过，脚本语法与差异检查通过；同步 `README.md` 验收说明。
- 本次优化访问和书库分面请求：`/api/books` 支持 `compact=1`、`count=0`，普通分页用 `COUNT(*) OVER()` 返回总数，整页标签改为一次批量查询；推荐响应不缓存，普通书目、标签和书架使用短期私有缓存。
- 本次将标签分面与当前账号可见书架合并为 `/api/library/facets`，书库用 `sessionStorage` 缓存 60 秒并在书架变更后强制刷新；`public/api.js` 对同页并发 `auth/me` 去重，书目和推荐筛选请求会取消过期请求，减少无效响应和 D1/Worker 消耗。响应保持账号私有，不读取 Telegram 原文件。
- 验证：新增分面接口、登录态 Promise 去重、紧凑书目批量标签、推荐跳过总数查询和缓存策略测试；`npm test` 142 项通过，Chromium 响应式验收 460/460 通过，涉及文件语法检查和 `git diff --check` 通过。
- 本次新增上传后 AI 书名清洗：`functions/utils/ai-classification.js` 增加 `cleanBookTitle()`，按用户提供的清洗提示词只输出主书名；`functions/api/upload/complete.js` 在新书入库后在后台先清洗书名，再基于清洗结果执行联网检索与 AI 分类。清洗失败保留原始识别书名，不阻塞上传响应，不触碰 Telegram 原文件与 R2 封面。
- 验证：新增书名清洗单元测试、失败回退测试、OpenAI/Anthropic Provider 复用测试和上传后台接线测试；`npm test` 148 项通过，涉及文件语法检查和 `git diff --check` 通过。
- 本次新增批量清洗现有书名：`/api/ai/title-clean` 支持查询待清洗数量与分批执行，受每日 AI 额度保护，跳过已清洗书籍并支持强制重洗；`books` 表新增 `title_cleaned_at` 标记（迁移 `0015`），备份列同步包含该字段；管理页新增“清洗现有书名”按钮与进度显示。失败保留原书名，不触碰 Telegram 原文件与 R2 封面。
- 验证：新增批量接口权限、额度、失败保留与标记测试，备份列断言；`npm test` 152 项通过，响应式验收 460/460 通过，语法检查和 `git diff --check` 通过。
- 本次修复书名清洗失败：失败 5 本中有 4 本的 `completion_tokens` 顶到旧上限 256，实测确认 `deepseek-v4.1-flash` 为推理型模型，会先输出 `reasoning_content`，256 token 被思考耗尽后正文为 `null`（`finish_reason=length`），回退取到的超长思考文本被 `normalizeCleanedTitle` 判为无效。将自定义 Provider 分支 `maxOutputTokens` 由 256 提到 1024、超时 30s 提到 45s，Workers AI 分支 `max_tokens` 由 128 提到 512。
- 验证：用真实 logfare.ai provider 复现，4 本失败书在 1024 预算下均返回正确书名；`npm test` 152 项通过；线上重新清洗后 55 本仅剩 1 本未清洗。
- 本次优化桌面和移动端界面：桌面展开导航，窄屏保留菜单；账号、标签和下载表格在手机变为带字段说明的卡片；表单桌面双列、手机单列；任务、长文件名、书名和别名允许断行；统一明暗主题、触控区域和键盘焦点。推荐请求增加过期响应保护，避免桌面结果覆盖手机布局。
- 本次触及 `public/` 的 8 个页面、共享样式与导航、上传/下载/标签/账号展示脚本及书库推荐请求；新增 `scripts/check-responsive-ui.mjs` 和 `tests/helpers/ui-fixtures.mjs`，更新 `README.md` 的验收说明。保留 163 个原有静态节点标识及接口、字段、筛选值与权限契约。
- 验证：120 项原有自动化测试全部通过；响应式检查 432/432 通过，覆盖 320、375、768、999、1000、1440、1920 像素宽度、长内容、明暗主题、触控尺寸、菜单关闭/断点切换、键盘选择文件、报告/下载筛选、标签编辑和推荐响应乱序。全部使用虚构数据，截图与日志存于被忽略的 `.wrangler/` 目录。
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

- 定时备份 Worker（`cf-book-backup-cron`）的 `ADMIN_TOKEN` 与 Pages 当前值一致（已用正确令牌手动触发成功）；若日后在 Pages 轮换 `ADMIN_TOKEN`，必须同步执行 `wrangler secret put ADMIN_TOKEN`（在 `workers/backup-cron/` 外、无占位 toml 干扰的目录，或带 `--name cf-book-backup-cron`），否则定时导出会 401。备份桶 `cf-book-backups` 仅保留最近 `KEEP_BACKUPS`（默认 14）份，更久的会被自动清理。
- `/stats` 为管理员页：中间件对无登录态的页面统一 302 跳 `/login`，非管理员登录后由 `stats.js` 前端提示“仅管理员可查看书库统计”，但 `/api/library/stats` 的真正鉴权在后端 `requireAdmin`（401/403），前端提示仅为体验层。
- 书库排序的 `sort`/`dir` 通过白名单映射到固定列名，非白名单键一律回落 `time-desc`，SQL 不拼接用户原始字符串；评分升序时未评分书 `rating_avg` 为 NULL，SQLite 视 NULL 最小会排在最前，属已验证的预期口径。
- 书库统计按标准标签分维度统计时，一本书最多 3 个标签，其 `file_size` 会在各标签下重复计入，面板已用文案说明；统计走私有短缓存（30s），线上数值在缓存窗口内可能略滞后。
- 个人评论随 `book_user_state` 存储且对所有登录账号可见（与评分同口径，不是私密笔记）；评论上限 500 字由前后端共同限制，`comment` 已纳入备份，迁移 `0018` 线上需执行后新列才生效。
- 单人/多人视图由 `/api/auth/me` 的 `multiUser` 驱动，是账号总数>1 的即时判断；该字段仅前端展示用途，后端评分/评论接口在单人时仍可写入，不依赖该标志做权限控制。
- 本次 Playwright 响应式验收为本机临时安装的浏览器模拟，未经 iOS Safari、Android 真机、软键盘与读屏器实测；新界面的真机表现仍待部署后观察。

- 同一页面从宽屏切到窄屏后，原有推荐可能排列为多行，这是保留同一批书的预期行为；首次加载和“换一批”的数量仍按当时列数抽取。
- 界面已用 Chromium 模拟桌面、平板和手机尺寸，未做 iOS Safari、Android 真机、软键盘和读屏器实测；超长名称会增加卡片高度，但不会以隐藏内容的方式掩盖越界。
- 公开书目匹配与 AI 标签可能不准确，需人工复核；标签合并/删除是管理员操作，误操作会改变已分类书籍，页面已加二次确认。
- 备份恢复是整表覆盖式写入，恢复到旧快照会丢失之后的改动；备份文件依赖 `BACKUP_KEY`，密钥丢失则无法解密。
- OPFS 与文件系统访问 API 依赖浏览器能力，Safari/移动端会回退到 Blob 合并，超大文件仍受内存限制。
- 上传任务状态存于浏览器 IndexedDB，清理浏览器数据会丢失任务记录（服务端未完成分块仍在）。
- 书目普通列表的私有缓存最长可能保留 5 秒，标签/书架分面浏览器缓存最长 60 秒；当前页面的书架增删改会主动失效，其他页面或账号设备上的变化要等缓存过期。
- `COUNT(*) OVER()` 已在 Node SQLite 全量测试中验证，仍需结合线上 D1 真实书库观察查询耗时和响应头命中情况；本次未读取生产书目内容。
- AI 书名清洗依赖已配置的 AI 接口；未配置或识别失败时书名保留原值，管理员可在书籍编辑页手动修正。
- 批量清洗受每日 AI 额度限制，未配置 AI 或额度用尽时不会强制调用；已清洗书籍默认跳过，接口支持强制重洗但管理页按钮目前只对未清洗书籍生效。
- 书名清洗仍受上游 AI 服务可用性影响：线上重洗期间 logfare.ai 间歇返回 HTTP 503“Service temporarily unavailable”。现已对 5xx/429/超时/网络类错误按 1500ms、4000ms 递增间隔加抖动自动重跑，确定性失败不重试；连续抖动超过两次仍会保留原书名，可稍后重试。
- 线上 55 本已全部清洗完成（`pending=0`）。其中 `[美]埃德加·斯诺` 一本为历史导入元数据写反（原文件 OPF 正确：`dc:title=西行漫记`、`dc:creator=[美]埃德加·斯诺`，但 D1 曾把书名与作者写反、`language`/`isbn` 为空；属 2026-10-09 08:59 上传时的 ZIP data descriptor 读取 bug，`cdbf9aa` 已修复，新导入不再受影响），已按原文件值直接改 D1：`title=西行漫记`、`author=[美]埃德加·斯诺`、`language=zh-CN`、`isbn=3300168271`，未改动 Telegram 原文件与 R2 封面；原文件 OPF 无 `dc:publisher`，`publisher` 仍为空。
- 修复了分批清洗的跳书问题：管理页原先按 `offset` 分批，但已清洗书籍会离开待清洗集合，导致每批跳过书籍（实测 30 本只清洗 20 本）；现改为始终从头取并用 `exclude` 跳过本轮失败项，接口响应新增 `cleaned` 与 `pending`。

## 四、下次最该做的事

- 线上迁移已确认到位（`login_attempts` 表、`idx_books_sha256` 索引、`book_user_state.comment` 列均存在）；下一步在生产验证详情页评论保存与备份导出确实含 comment。
- 观察定时备份 Worker 首次按 cron（UTC 03:17）自动执行是否成功写入 R2，并建立定期抽样解密校验；轮换 `ADMIN_TOKEN` 时记得同步 Worker secret。
- 优先在 iOS Safari 与 Android 浏览器实机验证本次新界面（排序下拉、统计面板、评论文本域）及既有菜单、文件选择、键盘弹出、长任务列表。
- 部署后在真实书库核对 `/api/library/stats` 的格式/语言/标签聚合口径与耗时，再决定是否调整私有缓存窗口。
- 为备份增加恢复演练记录与定期校验（例如每月抽样解密一次备份）。
- 观察 OPFS/文件系统写入在移动端的实际表现，必要时为大文件下载补充后台任务。
- 按需清理线上 647 个从未使用的标准标签，或先用“合并重复标签”收敛。
- 部署后观察 `/api/books`、`/api/library/facets` 的真实响应耗时与 Cloudflare 用量，再按数据决定是否继续缩短或延长缓存窗口。
- 部署后上传一本书观察后台清洗与分类的实际效果，核对清洗前后书名和 AI 用量记录。
- 部署后先在管理页执行一次批量清洗，观察清洗数量、失败数和 AI 用量，确认无异常后完成收尾。
