# Cloudflare Worker · D1 短链 CDN 网关

通过 Cloudflare Worker 为**私有** S3 兼容存储桶（Backblaze B2 / Cloudflare R2 / AWS S3 / MinIO 等）提供「不可枚举短链」访问。短链默认带过期时间，也可签发永久链接；另提供 `/b/<key>` 公开图片、`/chapter-content/<key>` 章节正文和 `/book-export/<key>` 整书交付反代路径。

用户只能访问形如 `https://cdn.example.com/s/<id>` 的短链；Worker 经 D1 把 `<id>` 解析成「桶 + 对象 key + 过期信息」，再用 AWS SigV4 签名**流式**回源，全程不缓冲。后端 endpoint、bucket、对象路径、密钥对用户完全不可见。

公开图片可通过 `https://cdn.example.com/b/<key>` 访问。`/b/` 不查 D1、不签发、不鉴权，只把 `<key>` 映射到配置桶的固定 prefix 下，例如默认 `image/<key>`，再复用同一套 SigV4 流式回源、Range、HEAD、错误脱敏和响应头白名单逻辑。

章节正文可通过与 B2 对象 key 相同的 `https://cdn.example.com/chapter-content/...` 访问。该路径同样不查 D1、不鉴权，只允许 `chapter-content/` 前缀，并使用 `CHAPTER_CONTENT_BUCKET_ID` 指定的只读凭证签名回源。

> 基于官方样例 [backblaze-b2-samples/cloudflare-b2](https://github.com/backblaze-b2-samples/cloudflare-b2) 重构而来（v2，与 1.x 不兼容）。

## 安全模型

- **短链不可枚举**：`id` 为 `crypto.getRandomValues` 生成的 base64url 随机串，默认 16 字符（≈96bit），下限 12。
- **fail-closed**：D1 出错、配置非法、上游异常一律拒绝，绝不回退到直连真实路径。
- **不泄露后端**：错误响应不带 body、不透传 B2/XML 错误体与 `x-amz-*` 等头；成功响应仅白名单透传 `content-type/content-length/content-range/accept-ranges/etag/last-modified`。
- **下载文件名**：`/s/<id>` 按对象 key 末段生成 `Content-Disposition: attachment`；中文名通过 `filename*` 返回，旧客户端使用安全 ASCII 备用名。
- **稳定桶 id**：D1 存 `bucket_id`（稳定字符串，非数组下标），重排/增减桶不会让旧短链指向错桶。
- **对象 key 安全编码**：按段 RFC3986 编码，拒绝 `..`/`.`/空段/控制字符；`?`/`#`/空格/`%2e%2e` 均作字面字符处理。
- **永久链接显式标记**：D1 中 `exp = 0` 表示永不过期；普通链接使用 Unix 秒级过期时间。
- 凭证只存 secret（`BUCKETS`/`ADMIN_PASSWORD`），D1 只存桶 id + key + 过期信息，不存任何密钥。

## 路由

| 方法 + 路径                        | 行为                                                                 |
| ---------------------------------- | -------------------------------------------------------------------- |
| `POST /api/sign`                   | 管理员鉴权 → 生成短链 → `{url, id, exp}` 或永久链接响应              |
| `POST /api/revoke`                 | 管理员鉴权 → 删除某 id                                               |
| `GET /admin`                       | 简易同源签发页面（不嵌入 secret）                                    |
| `GET\|HEAD /s/<id>`                | 查 D1 → 带文件名的附件流式交付（支持 Range/多线程下载）              |
| `GET\|HEAD /b/<key>`               | 无状态公开图片反代 → `<B_PREFIX><key>`（支持 Range/HEAD）            |
| `GET\|HEAD /chapter-content/<key>` | 无状态章节正文反代 → 同名 `chapter-content/<key>`（支持 Range/HEAD） |
| `GET\|HEAD /book-export/<key>`     | 无状态整书交付反代 → 同名 `book-export/<key>`（支持 Range/HEAD）     |
| 已知路径用错方法                   | `405`                                                                |
| 其它任意路径                       | `403`（含直接访问 `/a.png`、`/<bucket>/key`）                        |

## 配置

### secrets（`wrangler secret put`，绝不写进 wrangler.toml）

| 名称             | 说明                                                                      |
| ---------------- | ------------------------------------------------------------------------- |
| `BUCKETS`        | 桶配置组 JSON 数组，每项 `{id,name,endpoint,region,keyId,applicationKey}` |
| `ADMIN_PASSWORD` | 签发 / 撤销 API 密码（长随机串，按 API key 对待）                         |

`BUCKETS` 示例（`buckets.json`）：

```json
[
  {
    "id": "b2main",
    "name": "1145141919810",
    "endpoint": "s3.us-west-004.backblazeb2.com",
    "region": "us-west-004",
    "keyId": "<application key id>",
    "applicationKey": "<application key>"
  }
]
```

- `id`：稳定唯一标识（`[A-Za-z0-9_-]{1,64}`），签发时用它引用桶。
- `endpoint`：裸 host（默认补 `https://`）、`https://host:port` 或 `http://host:port`——任意可连通的 S3 兼容端点。⚠️ http 以明文发送 SigV4 鉴权头与数据，仅在可信网络使用。
- 加桶 = 往数组里加一项带新 `id` 的对象；旧短链不受影响。

### vars（`wrangler.toml [vars]`）

| 名称                        | 默认     | 说明                                                                                      |
| --------------------------- | -------- | ----------------------------------------------------------------------------------------- |
| `CACHE_TTL_SECONDS`         | `86400`  | 成功响应的 `Cache-Control: max-age`                                                       |
| `TOKEN_TTL_SECONDS`         | `3600`   | 短链默认有效期（秒），可被签发请求覆盖                                                    |
| `TOKEN_ID_LENGTH`           | `16`     | 短 id 字符数（12–64）                                                                     |
| `B_BUCKET_ID`               | 无       | `/b/` 使用的固定桶 id，必须匹配 `BUCKETS` 中已有桶；缺失时 fail-closed                    |
| `B_PREFIX`                  | `image/` | `/b/` 映射前缀；非法时 fail-closed，当前部署显式配置为 `image/`                           |
| `CHAPTER_CONTENT_BUCKET_ID` | 无       | `/chapter-content/` 使用的固定桶 id，建议绑定仅可读取该前缀的独立凭证；缺失时 fail-closed |
| `BOOK_EXPORT_BUCKET_ID`     | 无       | `/book-export/` 复用的固定桶 id；缺失时 fail-closed                                       |

`BOOK_EXPORT_KEY_ID` 和 `BOOK_EXPORT_APPLICATION_KEY` 必须通过 Worker secret 提供，并绑定仅可读取 `book-export/` 的独立 application key。该路由不会回退到 `BUCKETS` 内的章节正文或图片凭证。

### D1

`wrangler.toml` 已配置 `[[d1_databases]] binding = "DB"`；表结构见 `migrations/0001_init.sql`。

## 部署

```bash
npm install

# 1) 建 D1，把输出的 database_id 填进 wrangler.toml 的 [[d1_databases]].database_id
npx wrangler d1 create cdn-links

# 2) 建表（远端；本地开发加 --local）
npx wrangler d1 migrations apply cdn-links

# 3) 设置 secrets
cat buckets.json | npx wrangler secret put BUCKETS
npx wrangler secret put ADMIN_PASSWORD

# 4) 部署
npx wrangler deploy
```

桶为私有，Cloudflare 默认不缓存带 `Authorization` 的上游响应；如需缓存，在桶的 Bucket Info 设 `{"Cache-Control":"public"}`（Backblaze B2）。

### 本地开发

```bash
cp .dev.vars.template .dev.vars   # 填 BUCKETS / ADMIN_PASSWORD（.dev.vars 已 gitignore）
npx wrangler dev
```

仓库当前 `wrangler.toml` 绑定了自定义域名 `s.514996.xyz`，部署时以本地配置覆盖 Cloudflare Dashboard 中同一 Worker 的远端配置。

## 使用

### 签发短链

```bash
curl -X POST https://cdn.example.com/api/sign \
  -H "authorization: Bearer $ADMIN_PASSWORD" \
  -H "content-type: application/json" \
  -d '{"bucket":"b2main","path":"/path/to/file.png"}'
# -> {"url":"https://cdn.example.com/s/aB3xK9_qZ1mP7nR2","id":"aB3xK9_qZ1mP7nR2","exp":1761000000}
```

永久链接：

```bash
curl -X POST https://cdn.example.com/api/sign \
  -H "authorization: Bearer $ADMIN_PASSWORD" \
  -H "content-type: application/json" \
  -d '{"bucket":"b2main","path":"/path/to/file.png","permanent":true}'
# -> {"url":"https://cdn.example.com/s/aB3xK9_qZ1mP7nR2","id":"aB3xK9_qZ1mP7nR2","exp":null,"permanent":true}
```

请求体字段：

- `bucket`：`BUCKETS` 里的稳定 `id`。
- `path`：对象 key（前导 `/` 可选）。
- `expiresIn`（可选）：有效秒数，覆盖 `TOKEN_TTL_SECONDS`。
- `permanent`（可选）：传 `true` 时生成永久链接，不能和 `expiresIn` 同时使用；响应为 `{url,id,exp:null,permanent:true}`。

也可以访问 `/admin` 使用同源签发页面；页面只向 `/api/sign` 发请求，不包含后端 endpoint、bucket name 或密钥。

### 访问 / 撤销

```bash
curl -L https://cdn.example.com/s/aB3xK9_qZ1mP7nR2 -o file.png   # 下载（支持 Range）
curl -X POST https://cdn.example.com/api/revoke \
  -H "authorization: Bearer $ADMIN_PASSWORD" -H "content-type: application/json" \
  -d '{"id":"aB3xK9_qZ1mP7nR2"}'
```

下载器的 Range 请求会原样转发并返回 `206`；HEAD 只返回含下载文件名的元数据、不下载全量。短链固定使用附件语义，需要浏览器内嵌展示时应使用对应的无状态读取路由。

### 公开图片反代 `/b/`

外部服务可自行生成确定性 key，并把图片上传到配置桶的固定 prefix 下：

```text
B2 object key: image/<our_id>
public URL:    https://cdn.example.com/b/<our_id>
```

`/b/<key>` 行为：

- 只允许 `GET` / `HEAD`；其它方法返回 `405`。
- 不查 D1、不调用签发 API、不需要管理员鉴权。
- `<key>` 允许没有扩展名；Worker 不根据扩展名猜测或设置 `Content-Type`。
- `Content-Type` 完全来自对象上传时写入的 B2/S3 metadata；Worker 只透传白名单中的 `content-type`。
- 普通 GET 成功响应会写入 Cloudflare 边缘缓存；Range 和 HEAD 仍绕过缓存。
- `<key>` 使用同一套对象 key 安全规则：拒绝空段、`.`、`..`、控制字符和反斜杠；`%2e%2e` 这类编码内容按字面字符处理，不作为目录穿越。
- 实际回源 key 永远是 `<B_PREFIX><key>`；非法 prefix 或桶配置会 fail-closed，不会回退到其它桶或真实路径。

### 章节正文反代 `/chapter-content/`

`GET|HEAD /chapter-content/<key>` 将完整 URL 路径作为同名 B2 对象 key 签名回源。该路径不查 D1、不接受任意前缀，也不会回退到 `/b/` 的图片凭证。生产环境应让 `CHAPTER_CONTENT_BUCKET_ID` 指向 `BUCKETS` 中仅允许读取 `chapter-content/` 的独立 application key。

普通 GET 成功响应写入 Cloudflare 边缘缓存，Range 和 HEAD 绕过缓存。腾讯云 EO 可把 `s.514996.xyz` 设为源站并保持路径不变；客户端访问 `https://s.o7n.cn/chapter-content/...` 时仍由本 Worker 生成 B2 签名。

### 整书交付反代 `/book-export/`

`GET|HEAD /book-export/<key>` 将完整 URL 路径作为同名 B2 对象 key 签名回源。路由只接受 `book-export/` 固定前缀，并通过 `BOOK_EXPORT_KEY_ID`、`BOOK_EXPORT_APPLICATION_KEY` 使用独立只读凭证；配置缺失时 fail-closed。

普通 GET 成功响应写入 Cloudflare 边缘缓存，Range 和 HEAD 绕过缓存。腾讯云 EO 保持路径不变时，`https://s.o7n.cn/book-export/...` 与 `https://s.514996.xyz/book-export/...` 读取同一对象。

## 测试

```bash
npm test          # 流式守卫 + vitest（@cloudflare/vitest-pool-workers，本地 D1 + mock 回源）
```

> 本地若设置了 `HTTP_PROXY`/`HTTPS_PROXY`，miniflare 会把 Worker 出站 fetch 路由到代理而**挂起**测试；`npm test` 已用 `cross-env` 在进程内清空代理变量规避（CI 无代理不受影响）。

## 过期清理

- **惰性**：访问到已过期短链时即 best-effort 删除该行（不阻塞响应）。
- **Cron**：`wrangler.toml` 的 `[triggers] crons` 每日批量清扫从未被访问的过期行。
- **永久链接**：D1 中 `exp = 0` 表示永不过期，不会被惰性删除或 Cron 清扫。

## CI

`.github/workflows/wrangler_dry_run.yml`：push 到 `main` 时跑 `wrangler deploy --dry-run`。
