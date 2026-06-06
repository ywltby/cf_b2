# D1 短链 + 私有 S3 兼容多桶 CDN 网关

本文记录本项目从透明 B2 代理重构为 D1 短链 CDN 网关后的当前设计状态。历史实现计划已经落地；后续开发应以当前代码、测试和本文件的“当前状态”描述为准。

## 目标

通过 Cloudflare Worker 为一个或多个私有 S3 兼容存储桶提供不可枚举短链访问。管理员签发 `/s/<id>` 短链，Worker 通过 D1 把 id 解析成桶 id、对象 key 和过期信息，再用 AWS SigV4 签名流式回源。

目标约束：

- 对用户隐藏 endpoint、bucket name、对象 key 和所有密钥。
- 普通链接按 Unix 秒过期，永久链接显式使用 `exp = 0`。
- 成功交付全程流式，不缓冲上游 body。
- 支持 Range、HEAD、视频播放和多线程下载。
- fail-closed：D1、配置或上游异常时拒绝请求，不回退到真实路径。

## 当前技术栈

- Cloudflare Workers ES module worker，入口 `index.js`
- Cloudflare D1，binding `DB`
- Cloudflare Cache API
- `aws4fetch` 负责 S3 SigV4 签名
- `wrangler` 4.x 本地开发和部署
- `vitest` + `@cloudflare/vitest-pool-workers` 做 Worker 测试
- `scripts/check-no-buffering.mjs` 做静态流式守卫

## 当前配置

`wrangler.toml` 当前配置要点：

| 类型   | 名称                | 当前值 / 说明                        |
| ------ | ------------------- | ------------------------------------ |
| Worker | `name`              | `cf_b2`                              |
| Worker | `main`              | `index.js`                           |
| Route  | custom domain       | `s.514996.xyz`                       |
| var    | `CACHE_TTL_SECONDS` | `"86400"`，成功 GET 响应的 `max-age` |
| var    | `TOKEN_TTL_SECONDS` | `"3600"`，普通短链默认有效秒数       |
| var    | `TOKEN_ID_LENGTH`   | `"16"`，短 id 字符数，代码允许 12-64 |
| D1     | `DB`                | `cdn-links`                          |
| Cron   | `[triggers]`        | `0 3 * * *`，每日清理过期普通链接    |

Secrets：

- `BUCKETS`：JSON 数组，每项 `{id,name,endpoint,region,keyId,applicationKey}`。
- `ADMIN_PASSWORD`：签发 / 撤销 API 密码。

`endpoint` 支持裸 host、`https://host:port`、`http://host:port`，但必须是纯 origin，不允许 path、query、userinfo。`http` 会明文传输 SigV4 鉴权头和对象数据，只应在可信网络使用。

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

字段语义：

- `id`：短链 id，由 `crypto.getRandomValues` 生成 base64url 随机串。
- `bucket_id`：`BUCKETS` 中稳定 id，不是数组下标。
- `p`：规范化后的对象 key，无前导 `/`。
- `exp > 0`：普通链接的 Unix 秒过期时间。
- `exp = 0`：永久链接。

## 路由

| 方法 + 路径         | 行为                   |
| ------------------- | ---------------------- |
| `POST /api/sign`    | 管理员鉴权，生成短链   |
| `POST /api/revoke`  | 管理员鉴权，删除 D1 行 |
| `GET /admin`        | 静态同源签发页面       |
| `GET\|HEAD /s/<id>` | 查 D1 并流式交付       |
| 已知路径用错方法    | `405`                  |
| 其它路径            | `403`                  |

签发普通链接：

```json
{ "bucket": "b2main", "path": "/path/to/file.png", "expiresIn": 3600 }
```

响应：

```json
{ "url": "https://cdn.example.com/s/<id>", "id": "<id>", "exp": 1761000000 }
```

签发永久链接：

```json
{ "bucket": "b2main", "path": "/path/to/file.png", "permanent": true }
```

响应：

```json
{
  "url": "https://cdn.example.com/s/<id>",
  "id": "<id>",
  "exp": null,
  "permanent": true
}
```

`permanent:true` 和 `expiresIn` 互斥；同时传会返回 `403`。

## 交付流程

1. 匹配 `/s/<id>`，只允许 GET 或 HEAD。
2. 查 D1：`SELECT bucket_id, p, exp FROM links WHERE id = ?`。
3. 未找到、已过期普通链接返回 `404`；已过期普通链接触发 best-effort 惰性删除。
4. `exp = 0` 视为永久链接，不走过期删除。
5. 解析并校验 `BUCKETS`，按 `bucket_id` 找桶配置。
6. 规范化对象 key，构造 S3 path-style origin URL。
7. Range 请求绕过缓存，只接受上游 `206`。
8. HEAD 请求按 GET 签名回源，拿到元数据后 abort body，返回无 body 响应。
9. 普通 GET 先查 Cache API，miss 后签名回源并 `new Response(resp.body, ...)` 流式返回。
10. 成功普通 GET 用 `ctx.waitUntil(cache.put(...))` 异步写缓存。

## 安全规则

- D1 错误返回 `503`，不回源。
- `BUCKETS` 缺失或 schema 非法 fail-closed。
- 上游 `404` 映射为 `404`；上游 `416` 映射为 `416`；其它上游错误泛化为 `502`。
- 交付端错误响应无 body，`cache-control: no-store`。
- 成功响应只透传 `content-type`、`content-length`、`content-range`、`accept-ranges`、`etag`、`last-modified`。
- 不透传 `x-amz-*`、XML 错误体、endpoint、bucket name、对象 key、密钥。
- 对象 key 拒绝控制字符、反斜杠、空段、`.`、`..`，并按段 RFC3986 编码。
- Range 请求如果上游忽略 Range 返回 `200`，最多重试 3 次；耗尽后取消 body 并返回 `502`。

## 清理策略

- 惰性清理：访问已过期普通链接时 best-effort 删除该 D1 行。
- Cron 清理：每天执行 `DELETE FROM links WHERE exp > 0 AND exp < ?`。
- 永久链接：`exp = 0`，不会被惰性清理或 Cron 清理删除。

## 测试与验收

当前测试命令：

```bash
npm test
```

测试由 `pretest` 流式守卫和 Vitest Worker 测试组成。当前覆盖 10 个测试文件、44 个用例：

- `test/routing.test.js`：路由、方法限制、默认拒绝。
- `test/sign.test.js`：管理员鉴权、bucket/key 校验、TTL、永久链接、互斥参数、配置 fail-closed。
- `test/deliver.test.js`：流式交付、头部白名单、特殊字符编码、内部缓存键。
- `test/range.test.js`：Range 206、重试、416、非 206 fail-closed。
- `test/head.test.js`：HEAD 和 HEAD+Range 无 body。
- `test/errors.test.js`：上游错误脱敏、D1 异常、过期惰性删除。
- `test/revoke.test.js`：撤销短链。
- `test/scheduled.test.js`：Cron 清理保留永久链接。
- `test/admin.test.js`：`/admin` 页面存在且不嵌入 secret。
- `test/smoke.test.js`：未知路径拒绝。

完成行为变更前应至少运行：

```bash
npm run format
npm test
npx wrangler deploy --dry-run
```

## 已部署状态

最近一次确认部署到 Cloudflare Worker：

- Worker：`cf_b2`
- 自定义域名：`s.514996.xyz`
- Version ID：`4f1d11c9-9906-41af-8a62-a12011fc9e7c`
- 线上 `/admin` 已返回包含 `id="permanent"` 的页面。

## 后续改动注意事项

- 涉及签发、交付、清理语义时同步更新 `README.md`、`CHANGELOG.md`、本文件和相关测试。
- 不要把 secret 写进 `wrangler.toml`、README 示例之外的真实配置或测试输出。
- 不要引入读取上游 body 的实现；`scripts/check-no-buffering.mjs` 会阻止这类改动。
- 不要把 D1 中的 `bucket_id` 换成数组下标，否则桶配置重排会让旧链接指向错误桶。
