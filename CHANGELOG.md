# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- Mapper 默认关闭 Worker 和客户端缓存，每次读取都直接回源 B2，并返回 `Cache-Control: no-store`。
- 将组合 Worker 拆为 `src/shortlink.js` 与 `src/mapper.js` 两个部署入口，共用 `src/b2.js`；短链 Worker 保留 D1/Cron 和 `/s/<id>` 的不透明流式交付，mapper 不绑定状态资源，可跨账号水平扩容。
- 新增 `wrangler.mapper.toml`、mapper Secret 模板与独立开发/部署命令；shortlink 只接受短链及其管理路由，mapper 对全部非空路径执行同名对象映射。
- 增加 `PUBLIC_BASE_URL`，确保经 `s.o7n.cn` CDN 回源调用签发 API 时，返回的短链仍使用公开 CDN 域名而不是 `s.514996.xyz` 回源 Host。
- 将原 `snippet-b2.js` 的整桶只读代理整合进 mapper：`GET|HEAD /<key>` 读取 `B_BUCKET_ID` 的同名对象，根路径返回 `404`，不保留测速页、业务专用分支或命名空间拦截。
- 删除 Snippet 专用的重复 SigV4/缓存实现，统一复用主 Worker 的严格 Range 重试、边缘缓存、流式响应和错误脱敏逻辑。
- 支持用 `/s/<id>?filename=<名称>` 设置下载展示文件名；参数非法或缺失时继续回退到对象 key 末段，不改变短链定位和权限。
- 修复 `/s/<id>` 未触发附件下载且缺少文件名的问题；GET、HEAD、Range 统一按对象 key 末段返回安全的 `Content-Disposition`，中文名使用 RFC 5987 编码。
- 所有 B2 回源统一使用 `BUCKETS` 中的只读凭证，删除直读和 book-export 的四个重复 Secret。
- 删除 `/b/<key> → image/<key>` 别名和 `B_PREFIX`；mapper fallback URL 现在始终与 B2 对象 key 完整一致。

### 重大重构 (Breaking) — D1 短链 CDN 网关 (2.0.0)

完全重写：从「透明 B2 S3 代理（对外暴露 bucket/对象路径）」改为「D1 短链网关」。**与 1.x 完全不兼容**——配置、路由、行为全部变化。

#### Added

- `POST /api/sign`：管理员密码（secret `ADMIN_PASSWORD`，`Authorization: Bearer` + SHA-256 常量时间比较）签发不可枚举短链 `/s/<id>`；定位信息（桶 id + 对象 key + 过期）存 D1，对用户不可见、不可改。
- 永久短链：`POST /api/sign` 支持 `permanent:true`，D1 以 `exp=0` 表示永不过期，交付和清理逻辑会保留该类链接。
- `POST /api/revoke`：撤销短链（删除 D1 行，立即失效）。
- `/admin`：同源静态签发页面，可填写管理员密码、桶 id、对象 key、TTL 或勾选永久链接；页面不嵌入 secret 或后端标识。
- `GET|HEAD /<key>`：新增无状态整桶直读 mapper，复用流式回源、Range、HEAD、边缘缓存和错误脱敏逻辑。
- 多桶 / 多服务商：secret `BUCKETS` 为桶配置组数组 `{id,name,endpoint,region,keyId,applicationKey}`，按**稳定 id**（非数组下标）引用；endpoint 用 `new URL` 解析，支持 scheme 与任意端口（B2 / R2 / AWS S3 / MinIO，http 仅可信网络）。
- 流式交付：全程 `new Response(upstream.body)` 不缓冲；Range → 206（透传 content-range/accept-ranges）、保留大文件重试、HEAD 不下载全量；适配视频 / 音频 / 多线程下载。
- 过期清理双保险：交付层命中即惰性删除 + 每日 Cron 批量清扫。
- 缓存：按内部 `bucketId+key` 键去重（同文件不同短链共用缓存），先鉴权后查缓存。
- 测试：vitest + `@cloudflare/vitest-pool-workers`（本地 D1 + mock 回源），含禁止读取上游 body 和浮空取消 Promise 的静态「流式守卫」。

#### Changed

- 配置模型：secret `BUCKETS` / `ADMIN_PASSWORD`；vars `CACHE_TTL_SECONDS` / `TOKEN_TTL_SECONDS` / `TOKEN_ID_LENGTH` / `PUBLIC_BASE_URL` / `B_BUCKET_ID`；D1 绑定 `DB`。
- fail-closed：D1 异常 → 503、上游错误泛化（404→404，其余→502）且不透传 B2 错误体；响应头白名单透传，绝不泄露 endpoint/bucket/key/`x-amz-*`。

#### Removed

- 透明代理模式、`$path` / `$host` 动态 bucket、`RCLONE_DOWNLOAD`、`ALLOW_LIST_BUCKET`、`ALLOWED_HEADERS`、按客户端请求头签名、`B2_*` 单桶配置变量。

## [1.2.0] - 2024-10-09

### Added

- `RCLONE_DOWNLOAD` environment variable allows use with rclone's `--b2-download-url` option, stripping the `file\` prefix from the incoming path; fixes [#16](https://github.com/backblaze-b2-samples/cloudflare-b2/issues/16)

## [1.1.1] - 2024-10-08

### Added

- README now includes instruction to run `npm install`, fixing [#17](https://github.com/backblaze-b2-samples/cloudflare-b2/issues/17)

### Fixed

- Return correct response for ranged HEAD requests ([@jamesgreenley](https://github.com/jamesgreenley))

### Changed

- Bumped direct dependencies to current versions
- Bumped `path-to-regexp` version in response to dependabot alert

## [1.1.0] - 2024-07-20

### Fixed

- Send `HEAD` requests as `GET`s, fixing #18.

### Changed

- Update `aws4fetch` version to 1.0.19 and remove now-redundant region parsing code.
- Fix/suppress IntelliJ warnings.
- Make git ignore local worker files and directories.

## [1.0.0] - 2024-07-20

Declaring current version as 1.0.0.
