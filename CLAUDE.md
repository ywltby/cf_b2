# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目目标

通过 Cloudflare Worker 代理访问一个或多个**私有** Backblaze B2 存储桶，使桶内对象只能经由 Cloudflare 公开访问。Worker 用 B2 应用密钥对每个上游请求做 AWS Signature V4 签名，浏览器/客户端本身不持有密钥。

## 技术栈

- 运行时: Cloudflare Workers (ES module worker，`export default { fetch }`)
- 语言: 原生 JavaScript（无 TypeScript、无构建步骤）
- 依赖: `aws4fetch`（对上游 S3 兼容请求做 SigV4 签名）
- 工具链: `wrangler` 4.x（本地开发 / 部署）、`prettier`（格式化）

## 常用命令

- `npm install` — 安装依赖（部署前必须先执行）
- `npx wrangler dev` — 本地开发服务器（http，端口 8787）
- `npx wrangler deploy` — 部署到 Cloudflare
- `npx wrangler deploy --dry-run` — 校验配置但不部署（CI 即跑这个）
- `npm run format` — 用 prettier 格式化 `**/*.{js,css,json,md}`
- 设置密钥: `echo "<b2 application key>" | npx wrangler secret put B2_APPLICATION_KEY`

注意 `package.json` 里的 `test` 脚本是占位符（`exit 1`），本仓库**没有测试框架**，不要假装能跑测试。

## 配置与密钥（关键）

- `wrangler.toml` 被 `.gitignore` 忽略，仓库内只有它作为模板的内容；本地需自行填写 `B2_APPLICATION_KEY_ID`、`B2_ENDPOINT`、`BUCKET_NAME` 等 `[vars]`。
- `B2_APPLICATION_KEY` 是**密钥**，绝不写进 `wrangler.toml`：生产用 `wrangler secret put`，本地开发放进 `.dev.vars`（由 `.dev.vars.template` 复制而来，也被 gitignore）。Wrangler 本地服务器读 `wrangler.toml` 的 vars 但读不到 secret，靠 `.dev.vars` 补齐。
- `BUCKET_NAME` 三种模式：固定桶名 / `$path`（取 URL 路径首段为桶名）/ `$host`（取 hostname 首个子域为桶名）。`$host` 模式必须为每个桶名配 Route 或 Custom Domain。
- 桶虽私有，但 Cloudflare 默认不缓存带 `Authorization` 头的响应，所以需在 B2 桶的 Bucket Info 里设 `{"Cache-Control":"public"}` 才能缓存。

## 架构（`index.js`，单文件）

请求流：客户端 → Worker → 签名后转发到 B2 S3 端点 → 原样返回。要点：

- **方法限制**: 仅允许 `GET` / `HEAD`，其余返回 405。
- **HEAD 特殊处理**: Cloudflare 会把上游 HEAD 改成 GET 而破坏签名（issue #18），所以所有上游请求都以 `GET` 签名发出；若原始请求是 HEAD，则用 `createHeadResponse` 返回无 body 的响应。
- **头部过滤** (`filterHeaders`): 剔除 `cf-*`、`UNSIGNABLE_HEADERS`（如 `accept-encoding`、条件请求头等，因 Cloudflare 不一定原样上传，会让签名失效）；若配置了 `ALLOWED_HEADERS`，则只保留白名单内的头。改签名相关逻辑时务必理解这一层，否则会产生 403。
- **Range 请求重试**: 大文件（约 >2GB）时 Cloudflare 可能忽略 range 返回整个文件。代码检测响应缺少 `content-range` 头时 abort 并重试，最多 `RANGE_RETRY_ATTEMPTS`(3) 次。
- **rclone 模式** (`RCLONE_DOWNLOAD`): 为 true 时剥掉路径里的 `file/`（或 `file/{bucket}/`）前缀，适配 rclone 的 `--b2-download-url`。
- **list bucket 控制** (`isListBucketRequest` + `ALLOW_LIST_BUCKET`): 默认拒绝列桶请求（404），需显式开启。

## CI

`.github/workflows/wrangler_dry_run.yml`：push 到 `main` 时跑 `wrangler deploy --dry-run`（需 `CLOUDFLARE_API_TOKEN` secret）。该 workflow 显式安装 wrangler 4.x，绕过 wrangler-action 自带的 3.x。

## 代码风格

遵循 `.prettierrc`：单引号、无分号、`trailingComma: all`、`tabWidth: 2`、`printWidth: 80`。改完 JS 用 `npm run format` 保持一致。

## 基本约定

- 所有文件统一 UTF-8 编码保存。
- 本地终端是 Windows PowerShell；连续执行多条命令时优先分开执行或用 `;`，不要用 `&&`。
- 临时文件用 `C:\Users\ysy13\AppData\Local\Temp\`，不要用 `/tmp`。

## 先计划后执行

- **新增功能或修改逻辑前，先制定 plan 并提交用户确认，确认后再写代码。** 禁止未经确认直接实现。
- plan 应包含：变更目标、涉及文件、关键实现思路、验证方式。
- 极小改动（typo、改一行注释）可口头说明后直接执行；凡涉及新增函数、修改逻辑、跨文件改动一律走 plan。
- 用户明确说"直接改"、"不用 plan"时可豁免。
- 可跳过 plan 直接修复的情况仅限：运行报错、CI 红灯、文案拼写错误、格式化。

## 协作原则

- 用户的问题若基于错误前提，明确指出。
- 不在代码、commit message、注释、文档中声明或暗示由 AI 生成；commit message 不加任何 AI 署名尾缀。
- 先理解现有代码和文档再改动；不要为"整理"顺手重构无关内容。

## 提交流程

- 完成修改后先自查，再 `git add` + `git commit`，最后向用户汇报。
- commit message 遵循 Conventional Commits，且必须有中文说明（例如 `fix(签名): ...`），正文说明改了什么、为什么改、影响范围。
- 一个 commit 只解决一类问题，禁止把无关改动揉成一个提交。
- `commit / push / 远端校验` 严格串行，禁止并行。
- 严禁 `--no-verify`。
- 有用户可见的行为变更时，同步更新 `CHANGELOG.md` 的 `[Unreleased]` 段（本仓库遵循 Keep a Changelog + 语义化版本）。
