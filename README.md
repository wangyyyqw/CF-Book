# CF-Book

基于 Cloudflare Pages、D1、R2 和 Telegram 私有频道的家庭/多人私人书库。系统只负责上传、整理、管理和下载，不提供在线阅读；书籍原文件分块保存在 Telegram，封面保存在 R2。

## 功能

- 支持 EPUB、PDF、MOBI、AZW3、TXT 和漫画压缩包等文件。
- 浏览器把文件切成默认 16 MiB 的分块，服务端逐块保存到 Telegram 私有频道，下载时校验并在浏览器端合并。
- 上传失败或中断后，重新选择同一文件会复用未完成任务，跳过已经保存的分块。
- 单文件上限 4 GiB；上传并发 5，下载并发 3。实际速度取决于浏览器、网络、Telegram 和 Cloudflare 边缘节点。
- 自动识别 EPUB/PDF/MOBI/AZW3 元数据；Kindle 格式按 PDB 记录精读 EXTH、支持双格式 KF8、Windows-1252/UTF-8 和内嵌 JPEG/PNG/GIF/WebP 封面，不整读大文件；EPUB 支持流式读取 ZIP、提取内嵌封面并压缩为 WebP，封面保存到 R2。
- 书库支持分页、搜索、阅读状态筛选、共享标准标签筛选和“无标签”筛选，不会一次加载全部书籍。
- 评分、阅读状态、收藏按账号分别保存；共享标准标签由成员共同使用，成员可以上传新书。
- 管理员可以创建成员、停用账号、重置密码和管理书籍。
- AI 分类先查询公开书目资料，再从标准标签库中选择 3 个标签；支持 Workers AI、OpenAI-compatible 和 Anthropic Messages 自定义接口。

## 架构

```text
浏览器
  │ HTTPS
  ▼
Cloudflare Pages + Pages Functions
  ├─ D1：账号、会话、书目、分块索引、标签、评分和 AI 记录
  ├─ R2：封面 WebP
  └─ Telegram Bot 私有频道：书籍原文件分块
```

原文件不会写入 R2，也不会由 Worker 整本读入内存。每个 Telegram 分块的消息 ID、文件 ID、大小和哈希保存在 D1。

## 前置条件

部署前需要：

1. 一个 Cloudflare 账号，并安装 Node.js 22 或更高版本（Wrangler 本身支持更低版本，但本仓库的测试使用 `node:sqlite`）。
2. 一个 Telegram Bot。通过 BotFather 创建后，记下 Bot Token。
3. 一个私有 Telegram 频道。把 Bot 加入频道并授予管理员权限，至少允许发送消息和删除消息。
4. 私有频道 ID。通常是 `-100` 开头的数字；不要把它和公开频道用户名混用。

Bot 必须在频道中，而不是只在 BotFather 中创建。若使用群组，也必须确保 Bot 有发送和删除消息的权限；本项目建议使用私有频道保存原文件。

## 获取代码

```bash
git clone https://github.com/wangyyyqw/CF-Book.git
cd CF-Book
npm install
npx wrangler login
```

`npm install` 安装测试和 AI Provider 所需的本地依赖；Wrangler 不需要全局安装。

## 创建 Cloudflare 资源

以下名称只是示例，可以替换成自己的名称：

```bash
npx wrangler pages project create cf-book --production-branch main
npx wrangler d1 create cf-book-db
npx wrangler r2 bucket create cf-book-covers
```

记录 `wrangler d1 create` 输出的 `database_name` 和 `database_id`。然后编辑仓库根目录的 `wrangler.toml`，把占位符替换成自己账号中的资源：

```toml
[[d1_databases]]
binding = "DB"
database_name = "你的 D1 数据库名称"
database_id = "你的 D1 database_id"

[[r2_buckets]]
binding = "COVERS"
bucket_name = "你的 R2 存储桶名称"
```

保留 `DB`、`COVERS` 和 `AI` 这三个绑定名。`wrangler.toml` 只放资源配置，不放 Token、密码或 API Key。

## 初始化 D1

### 新建空数据库

当前 `schema.sql` 是可读的结构快照，但历史原因使它只内置部分标准标签。新库请使用仓库提供的生成脚本，它会在被 Git 忽略的 `.wrangler/` 目录生成一次性 SQL，包含当前结构和完整的 878 个标准标签：

```bash
node scripts/bootstrap-d1.mjs
npx wrangler d1 execute 你的 D1 数据库名称 --remote \
  --file .wrangler/cf-book-bootstrap.sql
```

初始化完成后可以检查关键数量：

```bash
npx wrangler d1 execute 你的 D1 数据库名称 --remote --command \
  "SELECT COUNT(*) AS tags FROM standard_tags; SELECT COUNT(*) AS dimensions FROM tag_dimensions;"
```

结果应为 `878` 个标准标签和 `5` 个维度。生成的 `.wrangler/cf-book-bootstrap.sql` 含有完整的结构和种子数据，不要把它复制到 Git 仓库；它面向新建空库，不要在已有数据库上重复执行。

### 已有数据库

不要对已有生产库重复执行 `schema.sql`，也不要无脑执行整个 `migrations/` 目录。仓库同时保留了历史增量迁移和当前结构快照，重复执行部分迁移会出现“重复字段”或“重复标签”。

升级已有库时：

1. 先备份或在 Cloudflare 的预览/测试数据库验证。
2. 确认目标库已经执行到哪个迁移文件；D1 不会替项目自动维护本仓库的迁移记录。
3. 只按编号顺序执行尚未执行的迁移，每个文件只执行一次。迁移文件的完整顺序是 `0002` 至 `0018`；例如确认只缺少最后一项时：

   ```bash
   npx wrangler d1 execute 你的 D1 数据库名称 --remote \
     --file migrations/0018_book_user_comment.sql
   ```

4. 如果目标库已经包含某个迁移提供的字段或标签，跳过该迁移，不要用 `--force` 掩盖错误。

### 迁移核对

可以使用下面的查询确认常见结构是否存在：

```bash
npx wrangler d1 execute 你的 D1 数据库名称 --remote --command \
  "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
npx wrangler d1 execute 你的 D1 数据库名称 --remote --command \
  "PRAGMA table_info(ai_classifications);"
```

如果无法确认旧库的迁移状态，最稳妥的做法是先创建一个新的 D1，使用“新建空数据库”的初始化流程，再迁移已经确认的数据；不要直接在生产库试错。

## 配置 Pages Secrets

不要把以下内容写进 `wrangler.toml`、README、前端代码或 Git 提交。每条命令会交互式要求输入值：

```bash
npx wrangler pages secret put TG_BOT_TOKEN --project-name cf-book
npx wrangler pages secret put TG_CHAT_ID --project-name cf-book
npx wrangler pages secret put ADMIN_TOKEN --project-name cf-book
```

必填配置：

| 名称 | 作用 |
| --- | --- |
| `TG_BOT_TOKEN` | Telegram Bot Token。泄露后必须立即在 BotFather 撤销并重新生成。 |
| `TG_CHAT_ID` | 保存分块的私有频道 ID，例如 `-100...`。 |
| `ADMIN_TOKEN` | 首次创建管理员账号时使用的服务令牌。建议使用至少 32 字节随机值。 |

生成随机服务令牌示例：

```bash
openssl rand -hex 32
```

可选配置：

| 名称 | 作用 |
| --- | --- |
| `AI_CONFIG_SECRET` | 加密自定义 AI API Key 的独立秘密。未设置时使用 `ADMIN_TOKEN` 派生加密密钥。更换后需要重新保存 AI 配置。 |
| `AI_DAILY_LIMIT` | Workers AI 每日估算 Neurons 上限，默认 `10000`。自定义 AI Provider 不受该 Neurons 估算限制，但仍受供应商限流。 |
| `GOOGLE_BOOKS_API_KEY` | 可选的 Google Books API Key。 |
| `BOOK_SEARCH_API_URL` | 可选通用搜索 API 地址，支持 `{query}` 占位符或 `q` 参数。 |
| `BOOK_SEARCH_API_KEY` | 可选通用搜索 API Key。 |
| `SEARCH_API_URL` / `SEARCH_API_KEY` | 上述搜索配置的旧名称，只有未设置新名称时才会使用。 |
| `BACKUP_KEY` | 备份加密口令（PBKDF2 + AES-256-GCM）。未设置时无法生成加密备份，只能显式导出明文。更换或丢失后，已有的加密备份将无法恢复。 |

如果使用自定义 AI Provider，API Key 在服务端以 AES-GCM 加密写入 D1，不会通过配置读取接口返回。

## 备份与恢复

管理员在 `/users` 页面底部可以下载备份、预览数据量并执行恢复，也可以直接调用接口：

```bash
# 加密备份（默认），需要 BACKUP_KEY
curl -H "x-admin-token: $ADMIN_TOKEN" \
  https://cf-book.pages.dev/api/backup/export -o backup.json

# 明文备份，文件内含账号密码哈希与全部分块索引，只保存在可信位置
curl -H "x-admin-token: $ADMIN_TOKEN" \
  "https://cf-book.pages.dev/api/backup/export?encrypt=0" -o backup-plain.json
```

备份固定包含书目、账号、标签、评分与阅读状态，以及 `uploads` / `chunks` 两张表——后者是 Telegram 原文件在 D1 里的索引，和书目必须成对保存，只备份书目会导致恢复后有书却没有原文件。

恢复有两种模式：`merge` 只补齐备份中的数据，`replace` 先清空上述表再按备份重建。恢复过程只写 D1，不会删除或覆盖 Telegram 中的分块，也不会改动 R2 封面；因此恢复后请确认 Telegram 频道里对应的分块仍然存在（可在上传任务中心对单个任务执行“重新校验”）。恢复是幂等的，中途失败重新执行同一份备份即可收敛。

### 定时导出

Cloudflare Pages 不支持 Cron Triggers，定时导出由 `workers/backup-cron` 这个独立 Worker 完成：它按计划调用 `/api/backup/export`，把加密备份写入 R2 的 `backups/` 前缀，并只保留最近 `KEEP_BACKUPS` 份。

```bash
cd workers/backup-cron
# 先把 wrangler.toml 里的 CF_BOOK_URL 与 R2 bucket 换成真实值
npx wrangler secret put ADMIN_TOKEN
npx wrangler deploy
# 手动触发一次验证配置
curl -H "x-admin-token: $ADMIN_TOKEN" https://cf-book-backup-cron.<你的子域>.workers.dev
```

## 部署

确认 `wrangler.toml` 中的 D1/R2 绑定已经替换为真实资源后，从仓库根目录部署：

```bash
npx wrangler pages deploy public --project-name cf-book
```

Pages Functions 会随项目部署。部署后打开 Wrangler 输出的 `*.pages.dev` 地址，或在 Cloudflare Pages 项目中绑定自己的域名。

建议首次部署后先检查：

```bash
npx wrangler pages deployment list --project-name cf-book
```

然后访问 `/login`。如果 D1 中还没有账号，页面会显示“创建管理员账号”。输入刚才设置的 `ADMIN_TOKEN`、管理员用户名和密码后，系统会创建第一个管理员并直接登录。之后的正常登录只使用账号密码和 HttpOnly 会话 Cookie，不再输入服务令牌。

## 本地开发

复制本地变量模板：

```bash
cp .dev.vars.example .dev.vars
```

编辑 `.dev.vars`，填入只用于本机开发的 Bot、频道和服务令牌。该文件已被 `.gitignore` 忽略，不能提交。

为本地 D1 生成完整初始化 SQL 并执行：

```bash
node scripts/bootstrap-d1.mjs
npx wrangler d1 execute cf-book-db --local \
  --file .wrangler/cf-book-bootstrap.sql
```

启动 Pages 本地环境：

```bash
npx wrangler pages dev public \
  --d1 DB=cf-book-db \
  --r2 COVERS=cf-book-covers \
  --ai AI
```

本地打开 Wrangler 输出的地址，通常是 `http://localhost:8788`。如果不希望本地测试写入真实 Telegram 频道，请使用专门的测试 Bot 和测试频道。

## 首次使用

1. 打开 `/login`，使用 `ADMIN_TOKEN` 创建首个管理员。
2. 进入“账号管理”，为家庭成员创建 `member` 账号。
3. 进入上传页选择书籍；批量上传会按队列逐本处理。
4. 上传完成后，书籍原文件在 Telegram 私有频道，封面在 R2，书目索引在 D1。
5. 进入书籍详情页检查书名、作者、封面和标准标签。

管理员服务令牌不是日常登录密码，也不应该发给成员。若首个管理员已经创建，`/api/auth/setup` 会拒绝再次初始化。

## AI 分类

标准标签库来自 `data/book_tag_library_v1.json`，当前包含 5 个维度和 878 个标签。每本书的标准分类固定为三项：

- 出版书：`出版书 + 学科/领域 + 主题/内容`
- 网文：`网文 + 题材 + 情节设定/核心元素`

管理员可以在“账号管理”配置自定义 AI：选择 `OpenAI-compatible` 或 `Anthropic Messages`，填入 HTTPS 请求根地址和 API Key，点击“获取模型”，选择模型并保存。分类时服务端会：

1. 使用书名、作者和摘要查询 Google Books、中文维基、Open Library、豆瓣及可选搜索 API。
2. 压缩公开书目信息和候选标签，发送给已配置的 AI。
3. 验证模型返回的三个标签 ID、维度顺序和 `active` 状态。
4. 只把通过验证的标签写入共享标签关系。

资料不足、模型返回格式错误或标签维度不匹配时，分类会失败并保留错误记录，不会写入自由标签。AI 结果是辅助整理，仍应人工抽查。

## 测试

```bash
npm test
git diff --check
```

测试使用真实 SQLite 语句检查、鉴权、分页、标签、上传续传、封面和 AI Provider 等行为；测试不会连接生产 D1、Telegram 或外部 AI 服务。

### 桌面与移动端界面验收

`scripts/check-responsive-ui.mjs` 使用 Playwright 和虚构数据检查 8 个页面，不读取本地凭证、不连接生产接口、不启动真实上传下载。宽度覆盖 320、375、768、999、1000、1440、1920px，检查横向溢出、长文件名、手机卡片字段、触控区域、导航断点、暗色表单、键盘选择文件、筛选和推荐稳定性。推荐只在页面加载或主动点击“换一批”时请求；滚动、窗口高度变化和横竖屏切换不会重新随机抽取，现有书籍由布局自动重排。

在已有 Playwright 与 Chromium 的环境中运行（无需改项目依赖）：

```bash
node scripts/check-responsive-ui.mjs
```

若 Playwright 安装在独立工具目录，设置 `NODE_PATH` 指向该目录的 `node_modules`；可通过 `CHROMIUM_EXECUTABLE_PATH` 指定浏览器路径，`UI_OUTPUT_DIR` 指定截图目录。截图和日志应留在被忽略的 `.wrangler/` 目录，不提交到仓库。该验收是浏览器模拟，不替代 iOS Safari、Android 浏览器、软键盘与读屏器实机验证。

## 清空测试数据

`scripts/cleanup-data.mjs` 会清理 Telegram 分块消息、D1 书籍数据和 R2 封面，但不会删除账号表结构。默认只预览：

```bash
node scripts/cleanup-data.mjs
node scripts/cleanup-data.mjs --yes
```

`--yes` 会真实删除数据且不可恢复。脚本需要 `.dev.vars` 中的 `TG_BOT_TOKEN`，并要求 Bot 能删除频道消息；不要对生产书库直接执行，除非已经确认删除范围和备份。

## 常见问题

### 页面要求输入“初始服务令牌”

这是首次创建管理员的校验，不是普通登录。确认输入的值与 Pages Secret `ADMIN_TOKEN` 完全一致，且请求发往当前部署对应的 Pages 项目。首个管理员创建成功后刷新 `/login`，页面应切换为普通登录。

### Bot 搜索不到或上传失败

Bot 不需要被搜索来登录。把 Bot 用户名添加为私有频道管理员，并确认 Bot 没有被限制发送/删除消息；`TG_CHAT_ID` 必须是私有频道数字 ID。

### 上传失败并返回 HTML 或 `Unexpected token '<'`

这通常是错误的部署地址、旧部署仍在缓存，或 Pages Functions 没有随静态资源部署。先确认使用 `npx wrangler pages deploy public --project-name cf-book` 从仓库根目录部署，并检查部署列表；不要把 `public` 单独复制到其他静态托管服务。

### 封面没有显示

先检查 EPUB 是否存在 OPF 封面声明、或 MOBI/AZW3 是否有可识别的封面偏移，上传日志是否显示“识别书名”。Kindle 文件含 DRM 时只读取公开元数据，不破解或提取受保护封面；损坏图片、外链图片或非标准目录结构也可能无法自动提取，详情页可以手动上传封面。封面提取失败不会阻止原书入库，任务卡片会保留提示。

### 自定义 AI 获取模型失败

OpenAI-compatible 地址必须是供应商要求的 HTTPS API 根地址，通常形如 `https://example.com/v1`；Anthropic 地址必须支持 `GET /models` 或供应商声明的模型列表接口。系统不跟随重定向，也不允许本机、内网和带查询参数的地址。请直接填写最终 API 地址，并核对 API Key 权限和供应商限流。

## 安全注意事项

- 本仓库不应提交 `TG_BOT_TOKEN`、`ADMIN_TOKEN`、AI API Key、生产 D1/R2 标识、`.dev.vars` 或真实书目数据。
- 用户在聊天、截图、终端日志或提交历史中暴露过的 Token 都应视为已泄露，立即撤销并重新生成。
- Telegram 频道是原文件存储位置；删除书籍会尝试删除频道中的分块消息、D1 索引和 R2 封面，操作前应保留必要备份。
- Cloudflare、Telegram 和第三方 AI 的费用、速率限制、可用区域及数据保留政策由对应服务商决定。

## 已知限制

- 浏览器端对大文件计算整书哈希和下载合并仍可能占用较多内存；超过 1 GiB 的上传会跳过整书哈希，仅使用分块哈希校验。
- 断点续传是“重新初始化同一文件并跳过已保存分块”，不是服务端后台队列；清除浏览器文件或改变文件名、大小、哈希后无法复用任务。
- Telegram 分块下载、Cloudflare Pages 请求时长和浏览器网络状况会影响大文件传输速度。
- 自动元数据识别和 AI 分类都可能需要人工复核，不能替代专业编目。
