# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## 项目目标

这是一个双入口 Cloudflare Workers 项目。`src/shortlink.js` 负责 D1 短链、管理 API 和 Cron；`src/mapper.js` 负责无状态路径映射，可跨 Cloudflare 账号水平扩容。两者共用 `src/b2.js` 的 AWS Signature V4 与流式交付实现。

当前实现支持：

- 多个私有 S3 兼容桶：Backblaze B2、Cloudflare R2、AWS S3、MinIO 等。
- 普通过期短链：D1 `exp` 为 Unix 秒。
- 永久短链：`POST /api/sign` 传 `permanent: true`，D1 `exp = 0`。
- `GET|HEAD /s/<id>` 以附件方式流式交付，可用安全的 `filename` 查询参数覆盖展示文件名，缺失或非法时取对象 key 末段，支持 Range 和多线程下载。
- `GET|HEAD /<key>` 无状态直读 `B_BUCKET_ID` 中的同名对象，不查 D1、不鉴权；根路径 `/` 返回 `404`。
- `POST /api/revoke` 撤销短链。
- `GET /admin` 同源静态签发页面，不嵌入 secret。

## 技术栈

- 运行时：Cloudflare Workers ES module；入口为 `src/shortlink.js` 和 `src/mapper.js`。
- 语言：原生 JavaScript，无 TypeScript、无构建步骤。
- 存储：Cloudflare D1，binding 为 `DB`。
- 签名：`aws4fetch`，对上游 S3 兼容请求做 SigV4。
- 工具链：Wrangler 4.x、Prettier、Vitest、`@cloudflare/vitest-pool-workers`。

## 常用命令

- `npm install`：安装依赖。
- `npm run dev` / `npx wrangler dev`：本地开发服务器。
- `npm run dev:mapper`：使用 `.dev.vars.mapper` 启动 mapper。
- `npm run deploy` / `npx wrangler deploy`：部署到 Cloudflare。
- `npm run deploy:mapper`：使用 `wrangler.mapper.toml` 部署 mapper。
- `npx wrangler deploy --dry-run`：打包和配置校验，不部署。
- `npx wrangler deploy --dry-run -c wrangler.mapper.toml`：校验 mapper。
- `npm test`：先运行流式守卫，再运行 Vitest Worker 测试。
- `npm run test:watch`：监听模式跑测试。
- `npm run format`：Prettier 格式化 `**/*.{js,css,json,md}`。

`npm test` 会清空代理环境变量，避免 Miniflare 出站 fetch 被本机代理挂住。

## 配置与密钥

`wrangler.toml` 是 shortlink 配置：

- Worker 名称：`cf_b2`
- 入口：`src/shortlink.js`
- 自定义域名：`s.514996.xyz`
- 对外 CDN origin：`PUBLIC_BASE_URL=https://s.o7n.cn`，短链签发响应不得回退为回源 Host
- D1：`DB` -> `cdn-links`
- Cron：每天 `0 3 * * *` 清理过期行

`wrangler.mapper.toml` 是 mapper 配置：

- 入口：`src/mapper.js`
- Worker 名称和自定义域名按 Cloudflare 账号分别配置；不要把一个账号的域名复制到另一个账号
- 不绑定 D1、Cron、管理员密码或 token vars
- `B_BUCKET_ID` 只配置在 mapper

Secrets 不写入任何 Wrangler 配置：

- shortlink：`BUCKETS`、`ADMIN_PASSWORD`。
- mapper：`BUCKETS`。

每个桶 id 的所有路由统一使用 `BUCKETS` 项内的凭证。生产 key 必须只读；为支持 mapper 桶根直读和任意短链路径，不配置文件名前缀限制。

本地开发分别使用 `.dev.vars.template` 和 `.dev.vars.mapper.template`。Cloudflare Secret 值不可回读；丢失时从凭证源恢复或轮换，禁止临时增加返回/记录 Secret 的 Worker 路由。D1 只存稳定桶 id、对象 key 和过期信息，不存任何密钥。

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

shortlink 只接受以下路由；其它路径返回 `404`：

- `POST /api/sign`：管理员鉴权，签发短链。
  - 普通响应：`{url,id,exp}`
  - 永久响应：`{url,id,exp:null,permanent:true}`
  - `permanent:true` 和 `expiresIn` 互斥。
- `POST /api/revoke`：管理员鉴权，删除 D1 行，返回 `{deleted:boolean}`。
- `GET /admin`：返回静态签发页面。
- `GET|HEAD /s/<id>`：查 D1，校验过期，按桶配置签名回源，并按安全的 `filename` 查询参数或对象 key 末段设置附件文件名。

mapper 只实现 `GET|HEAD /<key>`：按段解码 URL 路径一次，使用 `B_BUCKET_ID` 对应的 `BUCKETS` 凭证直读同名对象。根路径 `/` 返回 `404`，其它方法返回 `405`；不保留 `/s`、`/api`、`/admin` 或任何业务前缀。

## 安全与交付规则

- fail-closed：已经匹配的短链发生 D1、配置、上游错误时一律拒绝，不回退到整桶直读。
- `/s/<id>` 永远由 shortlink Worker 解析并流式返回，不重定向，不向客户端暴露 B2 对象 key。
- 不泄露后端：交付端错误响应无 body，不透传 B2/XML 错误体、`x-amz-*`、endpoint、bucket name 或 key。
- 成功响应只白名单透传 `content-type`、`content-length`、`content-range`、`accept-ranges`、`etag`、`last-modified`；`/s/` 另由 Worker 生成 `Content-Disposition: attachment`，不得透传上游同名头。
- 对象 key 规范化：拒绝控制字符、反斜杠、空段、`.`、`..`；按段 RFC3986 编码。
- Range 请求严格要求上游返回 `206`；上游忽略 Range 返回 `200` 时会 abort 并重试，耗尽后返回 `502`，绝不把整文件返回给 Range 请求。
- HEAD 请求按 GET 签名回源，拿到元数据后 abort body，返回无 body 响应。
- 普通 GET 先查 D1、校验 exp，再查 Cache API；内部缓存键按 `bucketId+key` 去重。
- 整桶直读不使用 D1、不鉴权，知道对象 key 即可读取；所有非空路径复用 `B_BUCKET_ID` 对应的 `BUCKETS` 凭证和统一交付逻辑，不做前缀改写或命名空间拦截。
- mapper 不得增加 D1、Cron、`ADMIN_PASSWORD` 或 token 配置；额外账号只复制 mapper。
- 过期普通链接访问时 best-effort 惰性删除；Cron 批量删除 `exp > 0 AND exp < now`；永久链接不会被清理。

## 测试覆盖

测试目录：`test/`。

当前测试覆盖：

- mapper 同名路径映射、空根路径和方法限制。
- 签发鉴权、bucket/key 校验、TTL、永久链接、互斥参数。
- 流式交付、头部脱敏、内部缓存键、特殊字符编码。
- 原业务前缀与 `/s`、`/api`、`/admin` 等路径按普通对象 key 映射。
- Range、HEAD、上游错误、D1 fail-closed、过期惰性删除。
- 撤销、Cron 清理、`/admin` 页面。

`scripts/check-no-buffering.mjs` 是静态流式守卫：禁止 Worker 读取上游响应 body，例如 `.arrayBuffer()`、`.blob()`、非 `request` 的 `.text()` / `.json()`，并禁止浮空的响应体取消 Promise。

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
