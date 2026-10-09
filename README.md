# CF-Book 分块传输原型

Cloudflare Pages + D1 + Telegram Bot 私有频道的书籍分块上传/下载验证原型。

## 原理

- 浏览器把书籍按 8 MiB 分块，逐块上传到 Pages Functions。
- Worker 每块转存到 Telegram Bot 私有频道，并把 `message_id`、`file_id`、分块哈希写入 D1。
- 下载时浏览器逐块从 Worker 拉取（Worker 再从 Telegram 取回），校验分块哈希后在浏览器端合并成完整文件。
- 所有分块低于 Telegram 云端 Bot API 的 20 MiB 下载限制；书籍原始文件不落 R2，只存 Telegram。

## 目录

```text
schema.sql                 D1 表结构（uploads + chunks + books + tags + users + sessions）
migrations/                D1 增量迁移（含 AI 分类记录与重试保护）
wrangler.toml              Pages 构建配置（DB / ADMIN_TOKEN / TG 密钥）
scripts/cleanup-data.mjs   清空已上传数据（Telegram 分块 + D1 记录 + R2 封面），默认空跑
functions/
  _middleware.js           CORS、会话鉴权与页面登录跳转
  utils/                   db / hash / http / auth / telegram 封装
  api/auth/                登录、注销、当前账号、首次初始化、改密码
  api/users/               账号管理（管理员）
  api/upload/              初始化、分块上传、完成、中止、任务列表
  api/download/            下载清单、单块下载（含哈希校验）
public/
  login.html + js          登录页（无账号时自动切换为创建管理员）
  users.html + js          账号管理页（仅管理员）
  nav.js / api.js          顶栏账号区与同源请求封装
  index.html + app.js      上传页（分块 + 进度 + 哈希）
  download.html + js       下载页（逐块下载 + 本地合并）
  library.html + js        书库（卡片列表 + 搜索 + 状态筛选）
  book.html + js           书籍详情（编辑元数据 + 标签 + 评分 + 下载 + 删除）
tests/                     鉴权、书籍删除等单元测试（npm test）
```

## 本地运行

需要 Node.js 18+（含 `npx wrangler`）与 Cloudflare 账号。

```bash
npm install -g wrangler
wrangler login
wrangler d1 create [D1_DATABASE_NAME]          # 复制输出的 database_id
sed -i '' "s/REPLACE_WITH_YOUR_D1_DATABASE_ID/<你的 database_id>/" wrangler.toml
wrangler d1 execute [D1_DATABASE_NAME] --file schema.sql --remote
wrangler pages dev public --d1 DB=[D1_DATABASE_NAME] --binding TG_BOT_TOKEN --binding TG_CHAT_ID --binding ADMIN_TOKEN
```

或在 Cloudflare Dashboard 配置以下环境变量/密钥后部署：

```bash
wrangler pages deploy public
```

需要的密钥：

- `TG_BOT_TOKEN`：通过 BotFather 创建的 Bot Token。
- `TG_CHAT_ID`：私有频道 ID（如 `-1001234567890`），Bot 需加入该频道且有发送权限。
- `ADMIN_TOKEN`：服务令牌，供脚本与应急使用（请求头 `x-admin-token` 或 `Authorization: Bearer`），权限等同管理员；网页登录走账号会话，不再使用该令牌。

## 账号系统

- 首个管理员：打开 `/login`，系统检测到没有任何账号时会显示「创建管理员账号」，填完即登录。
- 角色：`admin` 可编辑/删除书籍、管理账号；`member` 可以上传、浏览与下载，但不能修改书籍基本信息或管理账号。
- 评分/阅读状态/收藏：存放在 `book_user_state`，每个账号独立一份；收藏与阅读状态可以同时存在。详情页同时显示所有账号的评分、状态与收藏标记，书库评分徽标显示所有评分的平均分。
- 标签：使用共享的标准标签库，所有登录账号都可以从出版书/网文及对应分类维度中选择；旧 `tags` / `book_tags` 数据不再用于新分类和筛选。
- 会话：登录后签发 30 天有效的 HttpOnly Cookie（`cfbook_session`），令牌哈希存 D1 `sessions` 表，改密码/停用/删除会吊销其全部会话。
- 管理员在 `/users` 创建账号、重置密码、切换角色、停用或删除；任何时刻至少保留一个可用管理员，且不能停用/删除自己。
- 密码使用 PBKDF2-SHA256（10 万次迭代 + 随机盐）存储，不保存明文。
- 删除书籍（管理员，`/book` 详情页）会一并删除 R2 封面、Telegram 频道里的全部分块消息、`chunks`/`uploads` 记录与个人评分状态，不会留下孤儿文件。顺序是先删封面与频道消息、最后删 D1 记录：任何一步失败都会中止且保留数据库记录，重试即可收敛。

## 清空全部已上传数据

`scripts/cleanup-data.mjs` 用于把书库恢复成刚部署完的空状态（保留账号表结构，不动 `users`/`sessions` 之外的表定义）：

```bash
node scripts/cleanup-data.mjs          # 空跑，打印将删除的书籍、消息与封面清单
node scripts/cleanup-data.mjs --yes    # 真正执行
```

执行顺序为 Telegram 分块消息 → D1 记录（`chunks`/`uploads`/`book_user_state`/`book_tags`/`tags`/`books`）→ R2 封面，结束后复核六张表计数是否归零。需要 `.dev.vars` 里有 `TG_BOT_TOKEN`，且 Bot 在频道内拥有删除消息权限。

## 生产部署状态

- Pages 项目：`cf-book`，生产地址会随每次部署生成新 URL，最新见 `wrangler pages deployment list --project-name cf-book`。
- 生产 D1：`[D1_DATABASE_NAME]`（id `[D1_DATABASE_ID]`），`uploads`/`chunks`/`books`/`tags`/`book_user_state`/`users`/`sessions` 表已初始化。
- 生产密钥：`TG_BOT_TOKEN`、`TG_CHAT_ID`、`ADMIN_TOKEN` 已通过 `wrangler pages secret put` 写入。
- 已验证：20 MiB 文件（3 块）真实上传至 Telegram 私有频道 → D1 记录 → 逐块下载 → 合并 → SHA-256 与原文件一致。
- 书库功能：上传完成后自动建档；书库列表（分页，每页 100 本，底部「加载更多」）、搜索、按个人状态筛选、共享标签、个人评分/状态、他人评分可见、详情编辑、下载原文件、删除。
- 已验证（下载链路）：示例书籍A 35.25 MiB / 3 块，逐块哈希一致、合并后 SHA-256 与 D1 记录完全相同、字节数一致。
- 已验证（分页）：`/api/books` 返回 `total`/`limit`/`offset`/`hasMore`，`limit=2` 三页取回 6 本不重不漏；`library.html`/`library.js`/`style.css` 线上与本地 md5 一致。
- 已验证（账号体系全链路，线上 37/37 通过）：首次初始化令牌校验、账号创建与登录、错误密码/过短密码拒绝、成员上传建档、成员之间不能互相操作上传任务（分块/完成/中止均 403）、评分与阅读状态与收藏各自一份且互相可见（平均分 8.0、评分人数 2、记录带账号名）、标签共享且成员二可改、成员不能删书/改书/管账号、未登录 401、管理员不能删除或停用自己、删除书籍连带清空 D1 与频道消息。验收账号与测试书已全部回收，`legacy` 评分行按原值还原。
- 已验证（净零残留的线上闭环）：`init → chunk → complete → 删除` 全链路 200，删除后 D1 三张表计数归零、频道内分块消息确认已消失，测试数据全部回收。
- 已实现（AI 书名与标签整理）：管理员页显示每日 10,000 Neurons 免费额度、已用量、剩余量、成功/失败请求数和进度条；分类会用书名+作者并行查询 Google Books、中文维基、Open Library、豆瓣和可选搜索 API，抽取并截断简介、分类、标签和关键词后再调用 Workers AI，结果写入共享标签，不上传原始书籍文件。历史生产验证中 10 本书已完成分类；武侠作品按作者和题材规则补充“武侠”标签。
- 当前版本支持管理员配置 OpenAI-compatible 或 Anthropic Messages 接口：HTTPS 地址、API Key、获取并选择模型；API Key 使用 AES-GCM 加密保存在 D1，读取配置时不回显密钥。未配置时回落到 Workers AI。
- 管理员可在每本书详情页单独触发 AI 标签生成；页面可展开查看模型响应、最终标签和密钥轮换游标，不显示密钥内容。
- AI 分类仅从 878 个标准标签中选出 3 个有序 ID（书籍类型、对应领域/题材、主题/设定）；低置信度结果要求人工审核，不写入自由标签。

## 已修复的缺陷

- `/api/upload/complete` 建档 SQL 占位符少一个，导致 `15 values for 16 columns`，上传到最后一步必 500、书籍永远建不出来。已修正，并由 `tests/sql.test.mjs`（用真实 SQLite `prepare` 扫描全部写库语句）兜住同类错误。
- 删除书籍原先只清 `books`/`book_tags`/`book_user_state`，`chunks`、`uploads` 与 Telegram 频道里的原文件全部遗留成孤儿。现按「封面 → 频道消息 → D1 记录」顺序清理，任一步失败即中止并保留记录，重试可收敛。
- 书库列表原先固定只取 100 本且「共 N 本」显示的是本页条数，几千本时会静默丢书。现在接口支持 `offset` 分页并返回真实总数，前端分页加载。

## AI 分类说明与限制

**标准标签分类已实现**：先按书名+作者检索 Google Books/维基/Open Library/豆瓣/可选搜索 API，再将压缩后的公开书目证据与标准标签候选提供给自定义 OpenAI-compatible / Anthropic Messages 或默认 Workers AI。模型必须返回库内三个标签 ID，顺序为书籍类型、领域/题材、主题/设定；服务端再次验证标签状态和维度后才写入 `book_standard_tags`。资料不足或模型要求审核时不写标签。

标准标签来源文件为 `data/book_tag_library_v1.json`。新增标签使用新的增量迁移（按序应用 `0008` 至 `0012_humanities_and_web_tags.sql`）；不要重写已应用的历史迁移。应用迁移前应确认目标 D1 已含此前 AI 配置迁移。

如需接入通用搜索 API，在 Pages 环境变量中设置 `BOOK_SEARCH_API_URL`（可用 `{query}` 占位符，或让程序追加 `q` 参数）和可选的 `BOOK_SEARCH_API_KEY`。Google Books 如需自己的配额可设置 `GOOGLE_BOOKS_API_KEY`。接口结果支持 `results`、`items` 或 `data` 数组，每条记录可提供 `title`/`name`、`author`/`authors`、`snippet`/`description`、`keywords`/`tags`/`categories` 字段；未配置或请求失败不会阻塞其他书目源和 AI 分类。

配置通用 AI：登录管理员账号后打开 `/users`，选择协议，填入服务商提供的 HTTPS API 根地址与 API Key，点击“获取模型”并选择模型后保存。OpenAI-compatible 地址应为兼容 Chat Completions 的 API 根地址（例如 `https://api.example.com/v1`）；Anthropic Messages 地址应对应服务商要求的根地址（官方格式一般以 `/v1` 结尾）。自定义 Provider 下批处理每次只处理一本书，避免单次批量调用集中消耗服务商额度。API Key 不会由配置读取接口返回；`AI_CONFIG_SECRET` 优先用于派生 AES-GCM 加密密钥，否则使用 `ADMIN_TOKEN`。轮换加密秘密后，必须重新保存 API Key。

书籍自带元数据仍可能没有分类信息，公开书目也可能匹配不到：

用线上真实书库逐块下载合并后解析 OPF，三本 EPUB 的元数据里都没有任何 `subject` 元素（不是命名空间写法问题，是整个元素不存在），也没有 `calibre:series` / `belongs-to-collection`：

| 书籍 | language | publisher | dc:subject | 系列 |
| --- | --- | --- | --- | --- |
| 示例书籍A | zh | 示例出版社 | 无 | 无 |
| 示例书籍B | en（实际是中文书，元数据本身有误） | 无 | 无 | 无 |
| 示例书籍C | zh | 示例出版社 | 无 | 无 |

结论：AI 分类会优先使用公开书目资料，并从标准标签库中选取 3 个匹配项；查不到书目证据或需要审核时不写入标签。结果仍是辅助整理，不等同于人工编目，管理员应复核书名和标签。

## 验收清单（原型验证）

- [ ] 上传 100 MB 文件：分块逐块上传，进度到 100%，状态变为 completed。
- [ ] 上传 1 GB 文件：全程不把整本书放进 Worker 内存，前端也不一次读入内存。
- [ ] 中断续传：上传中途刷新/中止后，再次初始化同一文件并跳过已上传分块。
- [ ] 分块哈希：D1 中每个分块有 `sha256` 且与 Telegram 取回内容一致。
- [ ] 下载合并：下载页逐块拉取、校验、合并，文件 SHA-256 与上传时一致。
- [ ] 失败重试：断网或 Telegram 429 时，失败分块可单独重试。

## 已知限制

- 已实现：传输链路、书籍元数据/标签/评分/搜索、书库分页、自动识别书名作者（EPUB/PDF/MOBI）、EPUB 封面流式提取+压缩、上传/下载并发、账号与角色、按用户隔离的评分/阅读状态、Workers AI 书名清理与 3 个共享标签、每日 AI 用量面板。尚未实现：断点续传。
- 上传默认并发 5 个分块、下载默认并发 3 个分块，每块 16 MiB；可在 `app.js` 的 `UPLOAD_CONCURRENCY` 与 `download.js` 的 `DOWNLOAD_CONCURRENCY` 调整。
- 上传整书 SHA-256 对 >1GB 文件跳过（分块哈希兜底）；封面在浏览器压缩为 WebP（最长边 500px，质量 0.8）。
- 浏览器端整书哈希计算与大文件合并会占用内存，1 GB 以上文件建议后续改用流式写入（File System Access API / OPFS）。
- 断点续传为“重新初始化 + 跳过已上传分块”，后续可升级为按 `uploadId` 续传。

## 待决问题

1. **分类质量复核**：公开书目匹配质量取决于原始书名/作者元数据；AI 结果仍需管理员抽查。
2. **清空已上传数据**：`scripts/cleanup-data.mjs` 已就绪，涉及真实书籍，删除不可恢复，执行前必须确认。
