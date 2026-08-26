# Cloudflare Worker · D1 短链 CDN 网关

同一仓库部署两个 Cloudflare Worker，为**私有** S3 兼容存储桶（Backblaze B2 / Cloudflare R2 / AWS S3 / MinIO 等）提供不可枚举短链和无状态只读反代：

- `src/shortlink.js`：`/api/*`、`/admin`、`/s/<id>`，持有 D1 和 Cron。
- `src/mapper.js`：仅处理 `GET|HEAD /<key>` 的同名对象映射，不持有 D1，可跨账号水平扩容。

短链形如 `https://cdn.example.com/s/<id>`；短链 Worker 经 D1 把 `<id>` 解析成「桶 + 对象 key + 过期信息」，再用 AWS SigV4 签名**流式**回源，全程不缓冲、不重定向，也不会把真实 B2 key 暴露给客户端。直读 URL 形如 `https://cdn.example.com/<key>`，由 mapper 替代原 `snippet-b2.js` 服务；两个 Worker 共用 `src/b2.js` 中同一套安全回源实现。

`chapter-content/...`、`book-export/...` 等路径都按普通对象 key 处理，不存在专用分支或额外桶配置。

> 基于官方样例 [backblaze-b2-samples/cloudflare-b2](https://github.com/backblaze-b2-samples/cloudflare-b2) 重构而来（v2，与 1.x 不兼容）。

## 安全模型

- **短链不可枚举**：`id` 为 `crypto.getRandomValues` 生成的 base64url 随机串，默认 16 字符（≈96bit），下限 12。
- **fail-closed**：已匹配的短链发生 D1、配置或上游错误时直接拒绝，绝不降级到整桶直读。
- **整桶直读是公开能力**：知道对象 key 即可通过 `/<key>` 读取；`B_BUCKET_ID` 应使用只读凭证，不能把路径保密当作访问控制。
- **不泄露后端**：错误响应不带 body、不透传 B2/XML 错误体与 `x-amz-*` 等头；成功响应仅白名单透传 `content-type/content-length/content-range/accept-ranges/etag/last-modified`。
- **下载文件名**：`/s/<id>?filename=<名称>` 可用安全的展示名称生成 `Content-Disposition: attachment`；缺失或非法时回退到对象 key 末段。中文名通过 `filename*` 返回，旧客户端使用安全 ASCII 备用名。
- **稳定桶 id**：D1 存 `bucket_id`（稳定字符串，非数组下标），重排/增减桶不会让旧短链指向错桶。
- **对象 key 安全编码**：按段 RFC3986 编码，拒绝 `..`/`.`/空段/控制字符；直读 URL 的每个路径段只解码一次后再校验。
- **永久链接显式标记**：D1 中 `exp = 0` 表示永不过期；普通链接使用 Unix 秒级过期时间。
- 凭证只存 secret（`BUCKETS`/`ADMIN_PASSWORD`），D1 只存桶 id + key + 过期信息，不存任何密钥。

## 路由

| Worker    | 方法 + 路径                        | 行为                                                            |
| --------- | ---------------------------------- | --------------------------------------------------------------- |
| shortlink | `POST /api/sign`                   | 管理员鉴权 → 生成短链 → `{url, id, exp}` 或永久链接响应         |
| shortlink | `POST /api/revoke`                 | 管理员鉴权 → 删除某 id                                          |
| shortlink | `GET /admin`                       | 简易同源签发页面（不嵌入 secret）                               |
| shortlink | `GET\|HEAD /s/<id>[?filename=...]` | 查 D1 → 带安全展示文件名的附件流式交付（支持 Range/多线程下载） |
| mapper    | `GET\|HEAD /<key>`                 | 直读 `B_BUCKET_ID` 中的同名对象；空 key（`/`）返回 `404`        |

shortlink 对 mapper 路径返回 `404`。mapper 没有保留命名空间：`/s/...`、`/api/...`、`/admin...` 及其编码形式都和其它非空路径一样映射为 B2 对象 key，因此 CDN 必须把短链路由发往 shortlink Worker。

## 配置

### secrets（`wrangler secret put/bulk`，绝不写进 Wrangler 配置）

| 名称             | shortlink | mapper | 说明                                                                      |
| ---------------- | --------- | ------ | ------------------------------------------------------------------------- |
| `BUCKETS`        | 是        | 是     | 桶配置组 JSON 数组，每项 `{id,name,endpoint,region,keyId,applicationKey}` |
| `ADMIN_PASSWORD` | 是        | 否     | 签发 / 撤销 API 密码（长随机串，按 API key 对待）                         |

短链模板是 `.dev.vars.template`，mapper 模板是 `.dev.vars.mapper.template`。Cloudflare Worker Secret 的值在写入后会在 Wrangler 和控制台隐藏，CLI 只能用 `wrangler secret list` 盘点名称；本地副本丢失时必须从原凭证系统恢复，无法恢复的密码或 B2 application key 应轮换后重新上传。

`BUCKETS` 值示例：

```json
[
  {
    "id": "1145141919810",
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
- `B_BUCKET_ID` 指向 mapper 读取的桶；mapper 只需该桶一组无文件名前缀限制的只读 key。
- 加桶 = 往数组里加一项带新 `id` 的对象；旧短链不受影响。

### vars

| 名称                | Worker             | 默认          | 说明                                                                       |
| ------------------- | ------------------ | ------------- | -------------------------------------------------------------------------- |
| `CACHE_TTL_SECONDS` | shortlink + mapper | `86400` / `0` | shortlink / mapper 缓存秒数；`0` 表示 `no-store` 且不使用 Worker Cache API |
| `TOKEN_TTL_SECONDS` | shortlink          | `3600`        | 短链默认有效期（秒），可被签发请求覆盖                                     |
| `TOKEN_ID_LENGTH`   | shortlink          | `16`          | 短 id 字符数（12–64）                                                      |
| `PUBLIC_BASE_URL`   | shortlink          | 请求源站      | 签发响应使用的公开 origin；当前为 `https://s.o7n.cn`                       |
| `B_BUCKET_ID`       | mapper             | 无            | `/<key>` 直读使用的固定桶 id，必须匹配 `BUCKETS`；缺失时 fail-closed       |

### D1

`wrangler.toml` 已配置 `[[d1_databases]] binding = "DB"`；表结构见 `migrations/0001_init.sql`。

## 部署

```bash
npm install

# 仅首次部署 shortlink：建 D1 并填写 wrangler.toml
npx wrangler d1 create cdn-links
npx wrangler d1 migrations apply cdn-links

# shortlink
cp .dev.vars.template .dev.vars
npx wrangler secret bulk .dev.vars -c wrangler.toml
npm run deploy

# mapper（不建 D1）
cp .dev.vars.mapper.template .dev.vars.mapper
npm run deploy:mapper
npx wrangler secret bulk .dev.vars.mapper -c wrangler.mapper.toml
```

首次创建 mapper 时，先部署脚本、再执行 `secret bulk`；在 Secret 齐全并完成直连验证前，不要把该源站加入 CDN。每个 Cloudflare 账号都应使用自己的 Worker 名称和自定义域名，当前仓库里的 `wrangler.mapper.toml` 只代表其中一个账号。

桶为私有，Cloudflare 默认不缓存带 `Authorization` 的上游响应；如需缓存，在桶的 Bucket Info 设 `{"Cache-Control":"public"}`（Backblaze B2）。

### 本地开发

```bash
cp .dev.vars.template .dev.vars
cp .dev.vars.mapper.template .dev.vars.mapper
npm run dev
npm run dev:mapper
```

`wrangler.toml` 是 shortlink 配置，绑定 `s.514996.xyz`；`wrangler.mapper.toml` 是无状态 mapper 配置。腾讯云 EO 域名 `s.o7n.cn` 应按顺序配置：

| EO 路径规则                     | 源站           |
| ------------------------------- | -------------- |
| `/api/*`、精确 `/admin`、`/s/*` | `s.514996.xyz` |
| 默认 `/*`                       | mapper 源站组  |

每个源站的回源 Host 必须跟随该源站自己的域名。额外 Cloudflare 账号只需复制 mapper 配置，改 Worker 名称和该账号拥有的自定义域名，上传同一组 mapper Secret；不要复制 D1、Cron 或管理员 Secret。`PUBLIC_BASE_URL=https://s.o7n.cn` 保证签发结果继续使用公开 CDN 域名。

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

### 整桶直读

`GET|HEAD /<key>` 把 URL 路径按段解码一次，读取 `B_BUCKET_ID` 指定桶中的同名对象。当前 mapper 将 `CACHE_TTL_SECONDS` 设为 `0`，所有 GET、HEAD 和 Range 请求都直接回源 B2，响应为 `Cache-Control: no-store`；错误响应仍经过统一脱敏，不透传 B2 XML 或 `x-amz-*`。

所有非空路径都保持原样；例如 `/b/foo.jpg`、`/chapter-content/v1/a.parquet`、`/book-export/v1/a.7z` 分别读取 B2 的同名 key，不做前缀改写。根路径 `/` 没有对象 key，因此返回 `404`。

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
