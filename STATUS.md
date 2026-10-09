# 项目状态

- 项目支持 Cloudflare Pages、D1、R2 与 Telegram Bot 存储的私人书库，包含账号、书目管理、分块上传下载、标准标签和 AI 分类。
- 标准标签库有 878 个标签、5 个维度；第三批增量迁移为 `migrations/0012_humanities_and_web_tags.sql`。
- EPUB 封面提取支持 OPF 相对路径、编码路径及 `../` 归一化；本地全量测试 56 项通过。
- AI 支持 Workers AI、OpenAI-compatible 与 Anthropic Messages；密钥加密保存在服务端存储中，不写入仓库。

## 一、架构健康度

- 模块总数：上传、下载、书库、账号、书籍元数据、标签与 AI 分类 7 个主要模块。
- 违规跨模块调用：本次未发现。

## 二、变更影响范围

- 标准标签、AI Provider 与 EPUB 封面处理；相关 D1 迁移位于 `migrations/`。
- 部署者须按自己的 Cloudflare 资源配置 `wrangler.toml` 和 Secrets；仓库不携带生产资源标识。

## 三、已知风险

- 公开书目匹配与 AI 标签可能不准确，需人工复核。
- 自定义 AI 服务商的费用、速率和兼容性由服务商决定。
- 大文件浏览器端合并仍占用内存，断点续传仍有改进空间。

## 四、下次最该做的事

- 按部署者自己的 Cloudflare 账号初始化 D1、配置 Secrets 并执行迁移后部署。
- 为大文件引入后台队列和流式下载/合并方案。
