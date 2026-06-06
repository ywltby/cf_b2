# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## 项目目标

这是一个 Cloudflare Worker D1 短链 CDN 网关。管理员通过 `POST /api/sign` 生成不可枚举短链 `/s/<id>`；Worker 在 D1 中把短链 id 映射到 `{bucket_id, p, exp}`，再用 `aws4fetch` 对私有 S3 兼容存储回源请求做 AWS Signature V4 签名并流式交付文件。

当前实现支持：

- 多个私有 S3 兼容桶：Backblaze B2、Cloudflare R2、AWS S3、MinIO 等。
- 普通过期短链：D1 `exp` 为 Unix 秒。
- 永久短链：`POST /api/sign` 传 `permanent: true`，D1 `exp = 0`。
- `GET|HEAD /s/<id>` 流式交付，支持 Range、视频、多线程下载。
- `GET|HEAD /b/<key>` 无状态公开图片反代，不查 D1、不签发、不鉴权。
- `POST /api/revoke` 撤销短链。
- `GET /admin` 同源静态签发页面，不嵌入 secret。

## 技术栈

- 运行时：Cloudflare Workers ES module worker，入口为 `index.js`。
- 语言：原生 JavaScript，无 TypeScript、无构建步骤。
- 存储：Cloudflare D1，binding 为 `DB`。
- 签名：`aws4fetch`，对上游 S3 兼容请求做 SigV4。
- 工具链：Wrangler 4.x、Prettier、Vitest、`@cloudflare/vitest-pool-workers`。

## 常用命令

- `npm install`：安装依赖。
- `npm run dev` / `npx wrangler dev`：本地开发服务器。
- `npm run deploy` / `npx wrangler deploy`：部署到 Cloudflare。
- `npx wrangler deploy --dry-run`：打包和配置校验，不部署。
- `npm test`：先运行流式守卫，再运行 Vitest Worker 测试。
- `npm run test:watch`：监听模式跑测试。
- `npm run format`：Prettier 格式化 `**/*.{js,css,json,md}`。

`npm test` 会清空代理环境变量，避免 Miniflare 出站 fetch 被本机代理挂住。

## 配置与密钥

`wrangler.toml` 当前配置：

- Worker 名称：`cf_b2`
- 入口：`index.js`
- 自定义域名：`s.514996.xyz`
- D1：`DB` -> `cdn-links`
- Cron：每天 `0 3 * * *` 清理过期行
- 公开图片反代：`B_BUCKET_ID` 指向 `BUCKETS` 中已有桶 id，`B_PREFIX` 当前为 `image/`

Secrets 不写入 `wrangler.toml`：

- `BUCKETS`：JSON 数组，每项 `{id,name,endpoint,region,keyId,applicationKey}`。
- `ADMIN_PASSWORD`：签发/撤销 API 密码，按 API key 对待。

本地开发复制 `.dev.vars.template` 为 `.dev.vars` 并填入上述 secret。D1 只存稳定桶 id、对象 key 和过期信息，不存任何密钥。

## 数据模型

迁移文件：`migrations/0001_init.sql`。

```sql
CREATE TABLE IF NOT EXISTS links (
  id        TEXT PRIMARY KEY,
  bucket_id TEXT NOT NULL,
  p         TEXT NOT NULL,
  exp       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_links_exp ON links(exp);
```

语义：

- `id`：短链随机 id。
- `bucket_id`：`BUCKETS` 中稳定的桶 id，不是数组下标。
- `p`：规范化后的对象 key，无前导斜杠。
- `exp > 0`：Unix 秒过期时间。
- `exp = 0`：永久链接。

## 路由与行为

- `POST /api/sign`：管理员鉴权，签发短链。
  - 普通响应：`{url,id,exp}`
  - 永久响应：`{url,id,exp:null,permanent:true}`
  - `permanent:true` 和 `expiresIn` 互斥。
- `POST /api/revoke`：管理员鉴权，删除 D1 行，返回 `{deleted:boolean}`。
- `GET /admin`：返回静态签发页面。
- `GET|HEAD /s/<id>`：查 D1，校验过期，按桶配置签名回源并流式返回。
- `GET|HEAD /b/<key>`：不查 D1，把 key 映射为 `<B_PREFIX><key>`，按 `B_BUCKET_ID` 指定桶签名回源并流式返回。
- 已知路径用错方法返回 `405`。
- 其它路径返回 `403`。

## 安全与交付规则

- fail-closed：D1 错误、配置非法、上游异常一律拒绝，不回退到真实路径。
- 不泄露后端：交付端错误响应无 body，不透传 B2/XML 错误体、`x-amz-*`、endpoint、bucket name 或 key。
- 成功响应只白名单透传 `content-type`、`content-length`、`content-range`、`accept-ranges`、`etag`、`last-modified`。
- 对象 key 规范化：拒绝控制字符、反斜杠、空段、`.`、`..`；按段 RFC3986 编码。
- Range 请求严格要求上游返回 `206`；上游忽略 Range 返回 `200` 时会 abort 并重试，耗尽后返回 `502`，绝不把整文件返回给 Range 请求。
- HEAD 请求按 GET 签名回源，拿到元数据后 abort body，返回无 body 响应。
- 普通 GET 先查 D1、校验 exp，再查 Cache API；内部缓存键按 `bucketId+key` 去重。
- `/b/` 不使用 D1 或签发状态，配置缺失或非法时 fail-closed；`Content-Type` 不猜测，完全来自上游对象 metadata。
- 过期普通链接访问时 best-effort 惰性删除；Cron 批量删除 `exp > 0 AND exp < now`；永久链接不会被清理。

## 测试覆盖

测试目录：`test/`。

当前测试覆盖：

- 路由默认拒绝和方法限制。
- 签发鉴权、bucket/key 校验、TTL、永久链接、互斥参数。
- 流式交付、头部脱敏、内部缓存键、特殊字符编码。
- `/b/` 公开图片反代、Range、HEAD、方法限制和配置/key 越界拒绝。
- Range、HEAD、上游错误、D1 fail-closed、过期惰性删除。
- 撤销、Cron 清理、`/admin` 页面。

`scripts/check-no-buffering.mjs` 是静态流式守卫：禁止 Worker 读取上游响应 body，例如 `.arrayBuffer()`、`.blob()`、非 `request` 的 `.text()` / `.json()`。

## 代码风格

遵循 `.prettierrc`：单引号、无分号、`trailingComma: all`、`tabWidth: 2`、`printWidth: 80`。改完 JS/Markdown/JSON 后运行 `npm run format`。

## 协作约定

- 先理解现有代码和测试再改动。
- 涉及行为变更时先补测试，再改实现。
- 用户可见行为变更同步更新 `README.md` 和 `CHANGELOG.md`。
- 不要顺手重构无关内容。
- 不要在代码、文档、commit message 中声明或暗示由 AI 生成。
- 本地终端是 Windows PowerShell；命令优先分开执行。

## 提交流程

除非用户另有要求，完成修改后：

1. `npm run format`
2. `npm test`
3. 必要时 `npx wrangler deploy --dry-run`
4. 汇报改动和验证结果

如用户要求提交，commit message 使用 Conventional Commits，并包含中文说明。
