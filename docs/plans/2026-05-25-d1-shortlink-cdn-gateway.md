# D1 短链 + 私有 S3 兼容多桶 CDN 网关 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 把官方 `backblaze-b2-samples/cloudflare-b2` Worker 改造成「D1 短链网关」：管理员用密码调 API 生成不可枚举的短链 `/s/<id>`，用户访问短链后 Worker 经 D1 解析出**桶 id + 对象 key + 过期时间**，再用 SigV4 签名流式回源私有 S3 兼容存储（B2/R2/AWS/MinIO），全程不缓冲、支持 Range/视频/多线程下载，且 fail-closed、绝不泄露 endpoint/bucket/key。

**Architecture:** 无加密 token——短链 `id` 是随机串，作为 D1 主键映射到一行 `{bucket_id, p(对象 key), exp}`。**`bucket_id` 是稳定字符串 id（不是数组下标）**，避免重排桶导致旧链接指向错桶。每个桶的完整凭证组（`id/name/endpoint/region/keyId/applicationKey`）存在单个 `BUCKETS` JSON secret 里并在解析时做 schema 校验；D1 只存桶 id 不存凭证。交付端先查 D1 鉴权、再查 Cloudflare Cache（按 `bucketId+key` 安全编码的内部键去重）、最后签名回源。Range 请求绕过 Cache 直接流式 206，并保留大文件重试逻辑；重试耗尽仍非 206 则取消 body 返回 502（绝不把整文件返回给 Range 请求）。

**Tech Stack:** Cloudflare Workers (ES module, `fetch`+`scheduled`)、原生 JS、`aws4fetch`(SigV4)、Cloudflare D1、Cloudflare Cache API、`vitest` + `@cloudflare/vitest-pool-workers`(测试)、`prettier`。

---

## 参考：最终配置与数据模型（所有任务共用）

### 配置项

| 类型 | 名称 | 示例 / 说明 |
|---|---|---|
| secret | `BUCKETS` | JSON 数组，每元素 `{id,name,endpoint,region,keyId,applicationKey}`，`id` 为稳定唯一字符串 |
| secret | `ADMIN_PASSWORD` | 签发/撤销 API 密码（长随机串，按 API key 对待） |
| [vars] | `CACHE_TTL_SECONDS` | `"86400"` 文件响应 `max-age`（intVar 校验 0..31536000） |
| [vars] | `TOKEN_TTL_SECONDS` | `"3600"` 短链默认有效期秒（intVar 校验 1..31536000） |
| [vars] | `TOKEN_ID_LENGTH` | `"16"` 短 id 字符数（intVar 校验 **12..64**，下限 12≈72bit 熵，默认 16≈96bit） |
| d1 | `DB` | `[[d1_databases]]` 绑定 |

`BUCKETS` 示例：

```json
[{"id":"b2main","name":"1145141919810","endpoint":"s3.us-west-004.backblazeb2.com","region":"us-west-004","keyId":"<key id>","applicationKey":"<application key>"}]
```

`endpoint` 可写：裸 host（默认补 `https://`，如 `s3.us-west-004.backblazeb2.com`）、`https://host:port`、或 `http://host:port`——**任意可连通的 S3 兼容端点都支持，含 http 与任意端口**。解析用 `new URL()`，必须是纯 origin（不含 path/query/userinfo）。⚠️ http 会以明文发送 SigV4 鉴权头与数据，仅在可信网络使用。

### D1 表

```sql
CREATE TABLE IF NOT EXISTS links (
  id        TEXT PRIMARY KEY,   -- 短链 id
  bucket_id TEXT NOT NULL,      -- 稳定桶 id（不是数组下标）
  p         TEXT NOT NULL,      -- 规范化后的对象 key（无前导斜杠）
  exp       INTEGER NOT NULL    -- 过期 Unix 秒
);
CREATE INDEX IF NOT EXISTS idx_links_exp ON links(exp);
```

### 路由

| 方法+路径 | 行为 |
|---|---|
| `POST /api/sign` | 管理员鉴权 → 生成短链 → 返回 `{url,id,exp}` |
| `POST /api/revoke` | 管理员鉴权 → 删除某 id |
| `GET\|HEAD /s/<id>` | 查 D1 → 流式交付 |
| 已知路径用错方法 | `405` |
| 其它任意路径 | `403` |

### 安全 / 行为铁律（每个任务都要守）

1. **fail-closed**：D1 出错、配置缺失/非法、上游异常一律拒绝，**绝不**回退到直接代理真实路径。
2. **不泄露**：**交付端**（`/s/<id>`）错误响应不带 body；**管理端**（`/api/*`）validation 错误可返回 JSON（如 `{"error":"invalid path"}`），但绝不含 secret/bucket/key/endpoint/内部细节。两端都不透传 B2/XML 错误体、不透传 `x-amz-*`/`authorization`/`server` 等头。交付成功响应头用**白名单**：`content-type, content-length, content-range, accept-ranges, etag, last-modified`。
3. **不缓冲**：成功响应一律 `new Response(upstream.body, …)`；禁止用 `arrayBuffer()/blob()/text()/json()` 读**上游响应** body（`request.json()` 读管理员小请求体允许）。由 `pretest` 静态守卫强制。
4. **不存在性预言机**：未知 id 与已过期 id 都返回 `404`。
5. **先鉴权后查缓存**：必须先 D1 解析+校验 exp，再 `cache.match`；`cache.match` 包 try/catch（出错按 miss），`cache.put` 用 `ctx.waitUntil(...catch(()=>{}))`。
6. **对象 key 安全**：把输入当对象 key（前导 `/` 可选，规范化时去掉）；`normalizeKey` 拒绝控制字符/`\`/空段/`.`/`..`；拼 origin URL 时按段做 RFC3986 编码（`encodeKey`），使 `?`/`#`/空格/`%2e%2e` 都变成字面 key 字符；缓存键用 `encodeURIComponent(bucketId)+encodeURIComponent(key)`。
7. **桶引用用稳定 id**：D1 存 `bucket_id`，运行时按 id 查 `BUCKETS`；下标绝不持久化。
8. **配置 schema 校验**：解析 `BUCKETS` 时校验每项字段与 endpoint 形态、id 唯一，非法即 throw → fail-closed；整数环境变量经 `intVar` 边界校验，错配回落默认值。
9. **Range 严格 206**：Range 请求只接受 206；416 透传为 416；重试耗尽仍非 206（含被忽略的 200）→ 取消 body → 502。绝不把 200 全量返回给 Range 请求。
10. 日志不打印 secret、id、完整 key。

---

## Task 1: 测试与配置脚手架

**Files:**
- Modify: `package.json`
- Create: `vitest.config.js`
- Create: `scripts/check-no-buffering.mjs`
- Create: `test/helpers.js`
- Create: `migrations/0001_init.sql`
- Modify: `wrangler.toml`（重写）
- Modify: `.dev.vars.template`（重写）
- Create: `index.js`（占位）
- Create: `test/smoke.test.js`

**Step 1: 改 `package.json`**

```json
{
  "scripts": {
    "pretest": "node scripts/check-no-buffering.mjs",
    "test": "vitest run",
    "test:watch": "vitest",
    "format": "prettier --write '**/*.{js,css,json,md}'",
    "deploy": "wrangler deploy",
    "dev": "wrangler dev"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.6.0",
    "prettier": "^3.7.4",
    "vitest": "~2.1.0",
    "wrangler": "^4.54.0"
  },
  "dependencies": {
    "aws4fetch": "^1.0.20"
  }
}
```

Run: `npm install` → Expected: 成功。

**Step 2: `scripts/check-no-buffering.mjs`（流式守卫，Node 环境运行）**

```js
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
const forbidden = [
  /\.arrayBuffer\s*\(/, // never needed
  /\.blob\s*\(/, // never needed
  /(?<!request)\.text\s*\(/, // upstream body read (request.* admin body is allowed)
  /(?<!request)\.json\s*\(/,
]
const hits = forbidden.filter((re) => re.test(src))
if (hits.length) {
  console.error('Streaming guard FAILED: index.js must not buffer upstream bodies:', hits.map(String))
  process.exit(1)
}
if (!/new Response\(\s*resp\.body/.test(src)) {
  console.warn('Streaming guard WARN: streaming pattern new Response(resp.body, ...) not found')
}
console.log('Streaming guard passed')
```

> 守卫禁止读**上游响应** body：`.arrayBuffer(`/`.blob(`/`.text(`/`.json(`；用负向后顾 `(?<!request)` 放行 `request.json()`（管理员小请求体）。注意 `index.js` 注释里也别出现这些片段以免误报。

**Step 3: 重写 `wrangler.toml`**

```toml
name = "cloudflare-b2"
main = "index.js"
# Pins Workers runtime behavior so future runtime changes can't silently break this Worker.
compatibility_date = "2024-09-01"
workers_dev = true

[vars]
CACHE_TTL_SECONDS = "86400"
TOKEN_TTL_SECONDS = "3600"
TOKEN_ID_LENGTH = "16"

# Secrets (set via `wrangler secret put`, do NOT put values here):
#   BUCKETS         JSON array: [{"id","name","endpoint","region","keyId","applicationKey"}]
#   ADMIN_PASSWORD  admin API password

[[d1_databases]]
binding = "DB"
database_name = "cdn-links"
database_id = "<run: wrangler d1 create cdn-links, paste id>"
migrations_dir = "migrations"

# Optional expired-row cleanup (Task 9):
# [triggers]
# crons = ["0 3 * * *"]
```

**Step 4: `migrations/0001_init.sql`**

```sql
CREATE TABLE IF NOT EXISTS links (
  id        TEXT PRIMARY KEY,
  bucket_id TEXT NOT NULL,
  p         TEXT NOT NULL,
  exp       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_links_exp ON links(exp);
```

**Step 5: `.dev.vars.template`**

```toml
# Copy to .dev.vars for `wrangler dev`. .dev.vars is gitignored.
BUCKETS = '[{"id":"b2main","name":"1145141919810","endpoint":"s3.us-west-004.backblazeb2.com","region":"us-west-004","keyId":"<key id>","applicationKey":"<application key>"}]'
ADMIN_PASSWORD = "<long random admin password>"
```

**Step 6: `vitest.config.js`**

```js
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            BUCKETS: JSON.stringify([
              {
                id: 'b2test',
                name: 'test-bucket',
                endpoint: 's3.us-west-004.backblazeb2.com',
                region: 'us-west-004',
                keyId: 'test-key-id',
                applicationKey: 'test-app-key',
              },
            ]),
            ADMIN_PASSWORD: 'test-admin-pass',
            CACHE_TTL_SECONDS: '86400',
            TOKEN_TTL_SECONDS: '3600',
            TOKEN_ID_LENGTH: '12',
          },
        },
      },
    },
  },
})
```

**Step 7: `test/helpers.js`**

```js
import { env } from 'cloudflare:test'

export async function resetDb() {
  await env.DB.prepare('DROP TABLE IF EXISTS links').run()
  await env.DB.prepare(
    'CREATE TABLE links (id TEXT PRIMARY KEY, bucket_id TEXT NOT NULL, p TEXT NOT NULL, exp INTEGER NOT NULL)',
  ).run()
}

// key 传规范化后的对象 key（无前导斜杠）
export async function insertLink(id, bucketId, key, exp) {
  await env.DB.prepare('INSERT INTO links (id, bucket_id, p, exp) VALUES (?, ?, ?, ?)')
    .bind(id, bucketId, key, exp)
    .run()
}

export const FUTURE = Math.floor(Date.now() / 1000) + 3600
export const PAST = Math.floor(Date.now() / 1000) - 10
```

**Step 8: 占位 `index.js`**

```js
export default {
  async fetch() {
    return new Response(null, { status: 403, headers: { 'cache-control': 'no-store' } })
  },
}
```

**Step 9: `test/smoke.test.js`**

```js
import { SELF } from 'cloudflare:test'
import { expect, test, beforeEach } from 'vitest'
import { resetDb } from './helpers.js'

beforeEach(resetDb)

test('unknown path is forbidden and not cacheable', async () => {
  const res = await SELF.fetch('https://cdn.example.com/whatever')
  expect(res.status).toBe(403)
  expect(res.headers.get('cache-control')).toBe('no-store')
})
```

**Step 10: 跑测试**

Run: `npm test` → Expected: pretest 守卫通过 + 1 passing。

**Step 11: Commit**

```bash
git add package.json package-lock.json vitest.config.js scripts/ wrangler.toml migrations/ .dev.vars.template index.js test/
git commit -m "chore(网关): 搭建 D1 短链网关的测试与配置脚手架

引入 vitest + @cloudflare/vitest-pool-workers、D1 绑定与迁移、流式守卫脚本，
重写 wrangler.toml/.dev.vars.template；D1 用稳定 bucket_id 而非数组下标。"
```

---

## Task 2: 路由与 fail-closed 默认

**Files:** Modify `index.js`；Create `test/routing.test.js`

**Step 1: `test/routing.test.js`**

```js
import { SELF } from 'cloudflare:test'
import { expect, test, beforeEach, describe } from 'vitest'
import { resetDb } from './helpers.js'

beforeEach(resetDb)

describe('routing rejects everything except known endpoints', () => {
  const cases = [
    ['GET', 'https://cdn.example.com/', 403],
    ['GET', 'https://cdn.example.com/a.png', 403],
    ['GET', 'https://cdn.example.com/test-bucket/a.png', 403],
    ['GET', 'https://cdn.example.com/s/', 403],
    ['POST', 'https://cdn.example.com/s/abc123', 405],
    ['GET', 'https://cdn.example.com/s/doesnotexist', 404],
  ]
  for (const [method, url, status] of cases) {
    test(`${method} ${url} -> ${status}`, async () => {
      const res = await SELF.fetch(url, { method })
      expect(res.status).toBe(status)
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(await res.text()).toBe('')
    })
  }
})
```

**Step 2: Run** `npm test -- test/routing.test.js` → Expected: FAIL。

**Step 3: 实现路由骨架 `index.js`**

```js
const ID_ROUTE = /^\/s\/([A-Za-z0-9_-]{1,64})$/
const SIGN_PATH = '/api/sign'

function noStore(status, statusText) {
  return new Response(null, { status, statusText, headers: { 'cache-control': 'no-store' } })
}

async function resolveLink(env, id) {
  // throws on D1 errors; caller maps to 503
  return env.DB.prepare('SELECT bucket_id, p, exp FROM links WHERE id = ?').bind(id).first()
}

// Best-effort delete that never blocks and never throws into the response path —
// the async IIFE's try/catch also catches a synchronous throw from prepare/bind.
function deleteLinkBestEffort(ctx, env, id) {
  ctx.waitUntil(
    (async () => {
      try {
        await env.DB.prepare('DELETE FROM links WHERE id = ?').bind(id).run()
      } catch {}
    })(),
  )
}

async function handleDeliver(request, env, ctx, id) {
  let row
  try {
    row = await resolveLink(env, id)
  } catch {
    return noStore(503, 'Service Unavailable')
  }
  const now = Math.floor(Date.now() / 1000)
  if (!row) return noStore(404, 'Not Found')
  if (row.exp < now) {
    deleteLinkBestEffort(ctx, env, id) // lazy cleanup; never blocks / never throws into response
    return noStore(404, 'Not Found')
  }
  return noStore(404, 'Not Found') // origin in later tasks
}

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname

    if (path === SIGN_PATH) {
      if (request.method !== 'POST') return noStore(405, 'Method Not Allowed')
      return noStore(501, 'Not Implemented') // Task 3
    }

    const m = path.match(ID_ROUTE)
    if (m) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return noStore(405, 'Method Not Allowed')
      }
      return handleDeliver(request, env, ctx, m[1])
    }

    return noStore(403, 'Forbidden')
  },
}
```

**Step 4: Run** `npm test -- test/routing.test.js` → Expected: PASS。

**Step 5: Commit** `feat(网关): 实现路由与 fail-closed 默认拒绝`

---

## Task 3: 配置校验、对象 key 规范化、管理员鉴权与 `POST /api/sign`

**Files:** Modify `index.js`；Create `test/sign.test.js`

**Step 1: `test/sign.test.js`**

```js
import { SELF, env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import worker from '../index.js'
import { expect, test, beforeEach, describe } from 'vitest'
import { resetDb } from './helpers.js'

beforeEach(resetDb)
const AUTH = { 'content-type': 'application/json', authorization: 'Bearer test-admin-pass' }

async function sign(body, headers = AUTH) {
  return SELF.fetch('https://cdn.example.com/api/sign', {
    method: 'POST', headers, body: JSON.stringify(body),
  })
}

describe('POST /api/sign', () => {
  test('missing / wrong auth -> 401', async () => {
    expect((await sign({ bucket: 'b2test', path: '/a.png' }, { 'content-type': 'application/json' })).status).toBe(401)
    expect((await sign({ bucket: 'b2test', path: '/a.png' }, { 'content-type': 'application/json', authorization: 'Bearer nope' })).status).toBe(401)
  })

  test('valid -> 200 with url/id/exp and a D1 row (normalized key, stable bucket id)', async () => {
    const res = await sign({ bucket: 'b2test', path: '/a.png' })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.url).toMatch(/^https:\/\/cdn\.example\.com\/s\/[A-Za-z0-9_-]{12}$/)
    expect(json.id).toHaveLength(12)
    expect(json.exp).toBeGreaterThan(Math.floor(Date.now() / 1000))
    const row = await env.DB.prepare('SELECT * FROM links WHERE id = ?').bind(json.id).first()
    expect(row).toMatchObject({ bucket_id: 'b2test', p: 'a.png' }) // 前导斜杠被规范化掉
  })

  test('expiresIn override honored', async () => {
    const before = Math.floor(Date.now() / 1000)
    const { exp } = await (await sign({ bucket: 'b2test', path: '/a.png', expiresIn: 60 })).json()
    expect(exp).toBeGreaterThanOrEqual(before + 60)
    expect(exp).toBeLessThanOrEqual(before + 61)
  })

  test('unknown bucket id -> 403', async () => {
    expect((await sign({ bucket: 'nope', path: '/a.png' })).status).toBe(403)
    expect((await sign({ bucket: 0, path: '/a.png' })).status).toBe(403) // 下标不再被接受
  })

  test('invalid key -> 403', async () => {
    for (const p of ['../etc', '/a/../b', '', '/', '/a/./b', '/a\\b', '/a//b']) {
      expect((await sign({ bucket: 'b2test', path: p })).status, p).toBe(403)
    }
  })

  test('literal %2e%2e is accepted as a literal key (not traversal)', async () => {
    expect((await sign({ bucket: 'b2test', path: '/%2e%2e/x.png' })).status).toBe(200)
  })

  test('invalid expiresIn -> 403', async () => {
    for (const e of [0, -1, 1.5, 'x', 31536001]) {
      expect((await sign({ bucket: 'b2test', path: '/a.png', expiresIn: e })).status, String(e)).toBe(403)
    }
  })

  test('invalid json -> 400', async () => {
    const res = await SELF.fetch('https://cdn.example.com/api/sign', { method: 'POST', headers: AUTH, body: 'not json' })
    expect(res.status).toBe(400)
  })

  test('disabled when ADMIN_PASSWORD unset -> 401', async () => {
    const ctx = createExecutionContext()
    const req = new Request('https://cdn.example.com/api/sign', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bucket: 'b2test', path: '/a.png' }),
    })
    const res = await worker.fetch(req, { ...env, ADMIN_PASSWORD: undefined }, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(401)
  })

  test('malformed BUCKETS -> 500 fail-closed', async () => {
    const bad = [
      '[{"id":"x"}]', // 缺字段
      '[{"id":"a b","name":"n","endpoint":"s3.x.com","region":"r","keyId":"k","applicationKey":"s"}]', // id 含非法字符
      '[{"id":"x","name":"n","endpoint":"s3.x.com/extra/path","region":"r","keyId":"k","applicationKey":"s"}]', // endpoint 非纯 origin
      'not json', // 非 JSON
      '[]', // 空数组
    ]
    for (const BUCKETS of bad) {
      const ctx = createExecutionContext()
      const req = new Request('https://cdn.example.com/api/sign', { method: 'POST', headers: AUTH, body: JSON.stringify({ bucket: 'b2test', path: '/a.png' }) })
      const res = await worker.fetch(req, { ...env, BUCKETS }, ctx)
      await waitOnExecutionContext(ctx)
      expect(res.status, BUCKETS).toBe(500)
    }
  })
})
```

**Step 2: Run** `npm test -- test/sign.test.js` → Expected: FAIL（501）。

**Step 3: 实现（加到 `index.js`）**

```js
function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

function intVar(env, name, def, min, max) {
  const raw = env[name]
  if (typeof raw !== 'string' || !/^(0|[1-9]\d*)$/.test(raw)) return def // reject "12abc", "012", "", " 12"
  const n = Number(raw)
  return n >= min && n <= max ? n : def
}

// Parse an endpoint into a clean origin (scheme+host+port). Accepts a bare host
// (defaults to https) or an explicit http(s)://host[:port]. Any reachable S3-
// compatible endpoint is allowed, http and any port included. NOTE: http sends the
// SigV4 auth header + data in plaintext — document as trusted-network only.
function parseEndpoint(endpoint) {
  const e = /^https?:\/\//i.test(endpoint.trim()) ? endpoint.trim() : 'https://' + endpoint.trim()
  let u
  try {
    u = new URL(e)
  } catch {
    throw new Error('bucket endpoint invalid')
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('bucket endpoint scheme invalid')
  if (u.pathname !== '/' || u.search || u.hash || u.username || u.password) {
    throw new Error('bucket endpoint must be origin only')
  }
  return u.origin
}

// ---- bucket registry (parsed + schema-validated + memoized) ----
let _bucketsRaw = null
let _bucketsById = null
function getBuckets(env) {
  const raw = env.BUCKETS
  if (!raw) throw new Error('BUCKETS not configured')
  if (raw !== _bucketsRaw) {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('BUCKETS must be a non-empty array')
    const byId = new Map()
    const idRe = /^[A-Za-z0-9_-]{1,64}$/
    for (const c of parsed) {
      for (const f of ['id', 'name', 'endpoint', 'region', 'keyId', 'applicationKey']) {
        if (typeof c?.[f] !== 'string' || c[f].length === 0 || c[f].length > 1024) {
          throw new Error(`bucket field invalid: ${f}`)
        }
      }
      if (!idRe.test(c.id)) throw new Error('bucket id charset invalid') // id flows into D1/logs/URLs
      const origin = parseEndpoint(c.endpoint) // throws on invalid scheme/host/port
      if (byId.has(c.id)) throw new Error('duplicate bucket id')
      byId.set(c.id, { id: c.id, name: c.name, origin, region: c.region, keyId: c.keyId, applicationKey: c.applicationKey })
    }
    _bucketsById = byId
    _bucketsRaw = raw
  }
  return _bucketsById
}

// ---- object key validation ----
function normalizeKey(input) {
  if (typeof input !== 'string') return null
  const key = input.startsWith('/') ? input.slice(1) : input
  if (key.length === 0) return null
  if (key.includes('\\')) return null
  if (/[\x00-\x1f\x7f]/.test(key)) return null
  for (const seg of key.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return null
  }
  return key
}

// ---- id generation ----
function base64url(bytes) {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function generateId(len) {
  const bytes = new Uint8Array(Math.ceil((len * 3) / 4) + 2)
  crypto.getRandomValues(bytes)
  return base64url(bytes).slice(0, len)
}

// ---- auth ----
async function timingSafeEqual(a, b) {
  const enc = new TextEncoder()
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ])
  const va = new Uint8Array(ha), vb = new Uint8Array(hb)
  let diff = 0
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i]
  return diff === 0
}
async function authenticate(request, env) {
  if (!env.ADMIN_PASSWORD) return false
  const m = (request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/)
  return m ? timingSafeEqual(m[1], env.ADMIN_PASSWORD) : false
}

// ---- sign ----
async function handleSign(request, env) {
  if (!(await authenticate(request, env))) return noStore(401, 'Unauthorized')

  let body
  try { body = await request.json() } catch { return jsonResponse({ error: 'invalid json' }, 400) }

  let buckets
  try { buckets = getBuckets(env) } catch { return jsonResponse({ error: 'server misconfigured' }, 500) }

  if (typeof body.bucket !== 'string' || !buckets.has(body.bucket)) {
    return jsonResponse({ error: 'invalid bucket' }, 403)
  }
  const key = normalizeKey(body.path)
  if (!key) return jsonResponse({ error: 'invalid path' }, 403)

  let ttl = intVar(env, 'TOKEN_TTL_SECONDS', 3600, 1, 31536000)
  if (body.expiresIn !== undefined) {
    if (!Number.isInteger(body.expiresIn) || body.expiresIn <= 0 || body.expiresIn > 31536000) {
      return jsonResponse({ error: 'invalid expiresIn' }, 403)
    }
    ttl = body.expiresIn
  }
  const exp = Math.floor(Date.now() / 1000) + ttl
  const idLen = intVar(env, 'TOKEN_ID_LENGTH', 16, 12, 64) // floor 12 (~72bit); unguessable, no rate limit

  let id
  for (let i = 0; i < 5; i++) {
    id = generateId(idLen)
    try {
      await env.DB.prepare('INSERT INTO links (id, bucket_id, p, exp) VALUES (?, ?, ?, ?)')
        .bind(id, body.bucket, key, exp).run()
      break
    } catch (e) {
      if (String(e?.message).includes('UNIQUE') && i < 4) continue
      return noStore(503, 'Service Unavailable') // D1 quota / error
    }
  }
  const origin = new URL(request.url).origin
  return jsonResponse({ url: `${origin}/s/${id}`, id, exp })
}
```

路由里 `/api/sign` 的 `noStore(501,…)` 改为 `return handleSign(request, env)`。

**Step 4: Run** `npm test -- test/sign.test.js` → Expected: PASS。

**Step 5: Commit**

```bash
git add index.js test/sign.test.js
git commit -m "feat(网关): 配置 schema 校验、对象 key 规范化与 POST /api/sign 签发

BUCKETS 解析时校验字段/endpoint/唯一 id；key 规范化拒绝穿越/控制字符；
按稳定 bucket_id 写 D1；TTL/id 长度经 intVar 边界校验；密码常量时间比较。"
```

---

## Task 4: 交付正常路径 + 安全编码 + 缓存去重

**Files:** Modify `index.js`；Create `test/deliver.test.js`

**Step 1: `test/deliver.test.js`**

```js
import { SELF, env, fetchMock, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import worker from '../index.js'
import { expect, test, beforeAll, afterEach, beforeEach, describe } from 'vitest'
import { resetDb, insertLink, FUTURE } from './helpers.js'

const ORIGIN = 'https://s3.us-west-004.backblazeb2.com'

beforeAll(() => { fetchMock.activate(); fetchMock.disableNetConnect() })
beforeEach(resetDb)
afterEach(() => fetchMock.assertNoPendingInterceptors())

describe('GET /s/<id> happy path', () => {
  test('streams file, sanitizes headers, sets public cache-control', async () => {
    await insertLink('id0000000001', 'b2test', 'a.png', FUTURE)
    fetchMock.get(ORIGIN).intercept({ path: '/test-bucket/a.png', method: 'GET' }).reply(200, 'PNGDATA', {
      headers: {
        'content-type': 'image/png', 'content-length': '7', 'accept-ranges': 'bytes',
        etag: '"abc"', 'x-amz-request-id': 'LEAK', 'x-amz-id-2': 'LEAK2',
      },
    })
    const res = await SELF.fetch('https://cdn.example.com/s/id0000000001')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('PNGDATA')
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('cache-control')).toBe('public, max-age=86400')
    expect(res.headers.get('x-amz-request-id')).toBeNull()
    expect(res.headers.get('x-amz-id-2')).toBeNull()
  })

  test('keys with special chars are RFC3986-encoded into the origin URL', async () => {
    await insertLink('id0000000004', 'b2test', 'a dir/b?c#d.png', FUTURE)
    // 若 aws4fetch 对 S3 路径双重编码，这里的 path 不匹配 -> fetchMock 抛错 -> 测试失败（正是我们要的暴露）
    fetchMock.get(ORIGIN).intercept({ path: '/test-bucket/a%20dir/b%3Fc%23d.png', method: 'GET' }).reply(200, 'OK', {})
    const res = await SELF.fetch('https://cdn.example.com/s/id0000000004')
    expect(res.status).toBe(200)
  })

  test('endpoint scheme+port honored (MinIO-style; guards against host-only regression)', async () => {
    const BUCKETS = JSON.stringify([
      { id: 'minio', name: 'mybucket', endpoint: 'https://minio.example.com:9000', region: 'us-east-1', keyId: 'k', applicationKey: 's' },
    ])
    await insertLink('minio0000001', 'minio', 'a.png', FUTURE)
    fetchMock.get('https://minio.example.com:9000').intercept({ path: '/mybucket/a.png', method: 'GET' }).reply(200, 'OK', {})
    const ctx = createExecutionContext()
    const res = await worker.fetch(new Request('https://cdn.example.com/s/minio0000001'), { ...env, BUCKETS }, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(200) // 端口被保留进 origin URL
  })

  test('http endpoint is honored (trusted-network S3, e.g. local MinIO)', async () => {
    const BUCKETS = JSON.stringify([
      { id: 'http1', name: 'b', endpoint: 'http://minio.local:9000', region: 'us-east-1', keyId: 'k', applicationKey: 's' },
    ])
    await insertLink('http00000001', 'http1', 'a.png', FUTURE)
    fetchMock.get('http://minio.local:9000').intercept({ path: '/b/a.png', method: 'GET' }).reply(200, 'OK', {})
    const ctx = createExecutionContext()
    const res = await worker.fetch(new Request('https://cdn.example.com/s/http00000001'), { ...env, BUCKETS }, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(200) // http 端点（任意端口）走同一回源路径，防止误删 http 支持
  })

  test('two ids for same bucket+key hit one internal cache key', async () => {
    await insertLink('id0000000002', 'b2test', 'shared.bin', FUTURE)
    await insertLink('id0000000003', 'b2test', 'shared.bin', FUTURE)
    fetchMock.get(ORIGIN).intercept({ path: '/test-bucket/shared.bin', method: 'GET' })
      .reply(200, 'SHARED', { headers: { 'content-type': 'application/octet-stream' } }).times(1)

    // 用 worker.fetch + waitOnExecutionContext 确保第一次的 cache.put 落盘后再发第二次
    const ctx1 = createExecutionContext()
    const r1 = await worker.fetch(new Request('https://cdn.example.com/s/id0000000002'), env, ctx1)
    expect(await r1.text()).toBe('SHARED')
    await waitOnExecutionContext(ctx1)

    const ctx2 = createExecutionContext()
    const r2 = await worker.fetch(new Request('https://cdn.example.com/s/id0000000003'), env, ctx2)
    expect(await r2.text()).toBe('SHARED')
    await waitOnExecutionContext(ctx2)
    // afterEach 的 assertNoPendingInterceptors 确认上游只被调用一次
  })
})
```

> 若 pool 的 `caches.default` 在该环境为 no-op 导致去重测试不稳，标 `.skip` 并改在 `wrangler dev` 手验；其余测试不受影响。

**Step 2: Run** `npm test -- test/deliver.test.js` → Expected: FAIL。

**Step 3: 实现（`index.js` 顶部加 import；新增函数；替换 `handleDeliver` 回源占位）**

```js
import { AwsClient } from 'aws4fetch'

const PASS_THROUGH_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']

function encodeKey(key) {
  return key.split('/')
    .map((s) => encodeURIComponent(s).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()))
    .join('/')
}
function buildOriginUrl(cfg, key) {
  return `${cfg.origin}/${encodeURIComponent(cfg.name)}/${encodeKey(key)}`
}
function makeClient(cfg) {
  return new AwsClient({ accessKeyId: cfg.keyId, secretAccessKey: cfg.applicationKey, service: 's3', region: cfg.region })
}
function sanitizeHeaders(upstream, cacheControl) {
  const h = new Headers()
  for (const name of PASS_THROUGH_HEADERS) {
    const v = upstream.get(name)
    if (v !== null) h.set(name, v)
  }
  h.set('cache-control', cacheControl)
  return h
}
function mapUpstreamError(status) {
  if (status === 404) return 404
  if (status === 416) return 416
  return 502
}
```

替换 `handleDeliver`（Range/HEAD 分支在 Task 5/6 加入；此处先 normal GET）：

```js
async function handleDeliver(request, env, ctx, id) {
  let row
  try { row = await resolveLink(env, id) } catch { return noStore(503, 'Service Unavailable') }
  const now = Math.floor(Date.now() / 1000)
  if (!row) return noStore(404, 'Not Found')
  if (row.exp < now) {
    deleteLinkBestEffort(ctx, env, id) // lazy cleanup
    return noStore(404, 'Not Found')
  }

  let buckets
  try { buckets = getBuckets(env) } catch { return noStore(500, 'Server Error') }
  const cfg = buckets.get(row.bucket_id)
  const key = normalizeKey(row.p)
  if (!cfg || !key) return noStore(404, 'Not Found')

  const url = buildOriginUrl(cfg, key)
  const client = makeClient(cfg)
  const cacheControl = `public, max-age=${intVar(env, 'CACHE_TTL_SECONDS', 86400, 0, 31536000)}`

  // (Range 分支见 Task 5；HEAD 分支见 Task 6)

  const cache = caches.default
  const cacheKey = new Request(
    `https://cache.local/${encodeURIComponent(row.bucket_id)}/${encodeURIComponent(key)}`,
    { method: 'GET' },
  )
  try {
    const hit = await cache.match(cacheKey)
    if (hit) return hit
  } catch { /* treat as miss */ }

  let resp
  try { resp = await fetch(await client.sign(url, { method: 'GET' })) } catch { return noStore(502, 'Bad Gateway') }
  if (!resp.ok) {
    resp.body?.cancel() // release upstream error-body resources; never forward it
    return noStore(mapUpstreamError(resp.status), 'Upstream Error')
  }

  const response = new Response(resp.body, { status: 200, headers: sanitizeHeaders(resp.headers, cacheControl) })
  ctx.waitUntil(cache.put(cacheKey, response.clone()).catch(() => {}))
  return response
}
```

**Step 4: Run** `npm test -- test/deliver.test.js` → Expected: PASS。

**Step 5: Commit**

```bash
git add index.js test/deliver.test.js
git commit -m "feat(交付): 安全编码回源、流式返回与缓存去重

按稳定 bucket_id 查桶配置；对象 key 按段 RFC3986 编码拼 path-style URL；
响应头白名单透传、绝不泄露 x-amz-*；cache.match/put 包错误处理，按
bucketId+key 安全编码键去重。"
```

---

## Task 5: 流式 Range + 大文件重试（严格 206，绝不返回全量）

**Files:** Modify `index.js`；Create `test/range.test.js`

**Step 1: `test/range.test.js`**

```js
import { SELF, fetchMock } from 'cloudflare:test'
import { expect, test, beforeAll, afterEach, beforeEach, describe } from 'vitest'
import { resetDb, insertLink, FUTURE } from './helpers.js'

const ORIGIN = 'https://s3.us-west-004.backblazeb2.com'

beforeAll(() => { fetchMock.activate(); fetchMock.disableNetConnect() })
beforeEach(resetDb)
afterEach(() => fetchMock.assertNoPendingInterceptors())

describe('Range', () => {
  test('passes Range, returns 206, not cached (each request hits origin)', async () => {
    await insertLink('vid000000001', 'b2test', 'movie.mp4', FUTURE)
    await insertLink('vid000000002', 'b2test', 'movie.mp4', FUTURE)
    fetchMock.get(ORIGIN).intercept({ path: '/test-bucket/movie.mp4', method: 'GET' })
      .reply(206, 'PARTIA', { headers: { 'content-range': 'bytes 0-5/100', 'content-length': '6', 'accept-ranges': 'bytes', 'content-type': 'video/mp4' } })
      .times(2)
    const opts = { headers: { range: 'bytes=0-5' } }
    const r1 = await SELF.fetch('https://cdn.example.com/s/vid000000001', opts)
    expect(r1.status).toBe(206)
    expect(r1.headers.get('content-range')).toBe('bytes 0-5/100')
    expect(await r1.text()).toBe('PARTIA')
    const r2 = await SELF.fetch('https://cdn.example.com/s/vid000000002', opts)
    expect(r2.status).toBe(206)
  })

  test('retries when large-file response lacks content-range, then succeeds', async () => {
    await insertLink('big000000001', 'b2test', 'big.iso', FUTURE)
    const pool = fetchMock.get(ORIGIN)
    pool.intercept({ path: '/test-bucket/big.iso', method: 'GET' }).reply(200, 'FULL', { headers: { 'content-length': '4' } }).times(2)
    pool.intercept({ path: '/test-bucket/big.iso', method: 'GET' }).reply(206, 'CHUN', { headers: { 'content-range': 'bytes 0-3/9999', 'content-length': '4' } })
    const res = await SELF.fetch('https://cdn.example.com/s/big000000001', { headers: { range: 'bytes=0-3' } })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 0-3/9999')
  })

  test('3 attempts all non-206 -> 502, no body (never return full file to a Range)', async () => {
    await insertLink('bad000000001', 'b2test', 'big.iso', FUTURE)
    fetchMock.get(ORIGIN).intercept({ path: '/test-bucket/big.iso', method: 'GET' })
      .reply(200, 'WHOLEFILE', { headers: { 'content-length': '9' } }).times(3)
    const res = await SELF.fetch('https://cdn.example.com/s/bad000000001', { headers: { range: 'bytes=0-3' } })
    expect(res.status).toBe(502)
    expect(await res.text()).toBe('')
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  test('416 from upstream -> 416', async () => {
    await insertLink('r16000000001', 'b2test', 'x.bin', FUTURE)
    fetchMock.get(ORIGIN).intercept({ path: '/test-bucket/x.bin', method: 'GET' }).reply(416, '', {})
    const res = await SELF.fetch('https://cdn.example.com/s/r16000000001', { headers: { range: 'bytes=99999-' } })
    expect(res.status).toBe(416)
  })
})
```

**Step 2: Run** `npm test -- test/range.test.js` → Expected: FAIL。

**Step 3: 实现（加到 `index.js`，并在 `handleDeliver` 的 normal GET 之前插入 Range 分支）**

```js
const RANGE_RETRY_ATTEMPTS = 3

async function fetchRange(client, url, rangeHeader) {
  const signed = await client.sign(url, { method: 'GET', headers: { range: rangeHeader } })
  let attempts = RANGE_RETRY_ATTEMPTS
  let response
  do {
    const controller = new AbortController()
    response = await fetch(signed.url, { method: 'GET', headers: signed.headers, signal: controller.signal })
    if (response.status === 206) break
    if (response.ok) { // 200 = range 被忽略（大文件 bug）：丢弃重试
      attempts -= 1
      if (attempts > 0) { controller.abort(); continue }
    }
    break // 206 已 break；上游错误或重试耗尽落到这里
  } while (attempts > 0)
  return response
}
```

`handleDeliver` 内（`const cacheControl = ...` 之后、cache 之前）：

```js
  const isHead = request.method === 'HEAD'
  const rangeHeader = request.headers.get('range')

  if (rangeHeader) {
    let resp
    try { resp = await fetchRange(client, url, rangeHeader) } catch { return noStore(502, 'Bad Gateway') }
    if (resp.status !== 206) {
      resp.body?.cancel() // 绝不把 200 全量 / 错误体返回给 Range 请求
      if (resp.status === 416) return noStore(416, 'Range Not Satisfiable')
      return noStore(resp.status >= 400 ? mapUpstreamError(resp.status) : 502, 'Bad Gateway')
    }
    const headers = sanitizeHeaders(resp.headers, cacheControl)
    if (isHead) { resp.body?.cancel(); return new Response(null, { status: 206, headers }) }
    return new Response(resp.body, { status: 206, headers })
  }
```

**Step 4: Run** `npm test -- test/range.test.js` → Expected: PASS。

**Step 5: Commit**

```bash
git add index.js test/range.test.js
git commit -m "feat(交付): 流式 Range 与大文件重试，严格 206

Range 绕过缓存、流式 206 并透传 content-range；保留官方大文件 workaround；
重试耗尽仍非 206（含被忽略的 200）则取消 body 返回 502，绝不把全量返回给
Range 请求；HEAD+Range 取消 body 返回无体 206；416 透传。"
```

---

## Task 6: HEAD（不下载全量）

**Files:** Modify `index.js`；Create `test/head.test.js`

**Step 1: `test/head.test.js`**

```js
import { SELF, fetchMock } from 'cloudflare:test'
import { expect, test, beforeAll, afterEach, beforeEach } from 'vitest'
import { resetDb, insertLink, FUTURE } from './helpers.js'

const ORIGIN = 'https://s3.us-west-004.backblazeb2.com'

beforeAll(() => { fetchMock.activate(); fetchMock.disableNetConnect() })
beforeEach(resetDb)
afterEach(() => fetchMock.assertNoPendingInterceptors())

test('HEAD returns metadata headers and empty body', async () => {
  await insertLink('head00000001', 'b2test', 'clip.mp4', FUTURE)
  fetchMock.get(ORIGIN).intercept({ path: '/test-bucket/clip.mp4', method: 'GET' })
    .reply(200, 'IGNOREDBODY', { headers: { 'content-type': 'video/mp4', 'content-length': '12345', 'accept-ranges': 'bytes' } })
  const res = await SELF.fetch('https://cdn.example.com/s/head00000001', { method: 'HEAD' })
  expect(res.status).toBe(200)
  expect(res.headers.get('content-length')).toBe('12345')
  expect(res.headers.get('accept-ranges')).toBe('bytes')
  expect(await res.text()).toBe('')
})

test('HEAD + Range returns empty body 206', async () => {
  await insertLink('head00000002', 'b2test', 'clip.mp4', FUTURE)
  fetchMock.get(ORIGIN).intercept({ path: '/test-bucket/clip.mp4', method: 'GET' })
    .reply(206, 'PART', { headers: { 'content-range': 'bytes 0-3/100', 'content-length': '4' } })
  const res = await SELF.fetch('https://cdn.example.com/s/head00000002', { method: 'HEAD', headers: { range: 'bytes=0-3' } })
  expect(res.status).toBe(206)
  expect(res.headers.get('content-range')).toBe('bytes 0-3/100')
  expect(await res.text()).toBe('')
})
```

**Step 2: Run** `npm test -- test/head.test.js` → Expected: FAIL（无 Range 的 HEAD 还没分支）。

**Step 3: 实现（`handleDeliver` 内，Range 分支之后、normal GET 之前）**

```js
  if (isHead) {
    try {
      const controller = new AbortController()
      const signed = await client.sign(url, { method: 'GET' }) // issue #18: 按 GET 签名
      const resp = await fetch(signed.url, { method: 'GET', headers: signed.headers, signal: controller.signal })
      const headers = sanitizeHeaders(resp.headers, cacheControl)
      const status = resp.status
      controller.abort() // 停止 body 传输，不下载全量
      if (!resp.ok) return noStore(mapUpstreamError(status), 'Upstream Error')
      return new Response(null, { status, headers })
    } catch { return noStore(502, 'Bad Gateway') }
  }
```

> HEAD+Range 已在 Task 5 的 Range 分支内处理（`if (isHead) cancel + 无体 206`），故此分支只处理无 Range 的 HEAD。

**Step 4: Run** `npm test -- test/head.test.js` → Expected: PASS。

**Step 5: Commit** `feat(交付): HEAD 仅返回元数据且不下载全量`

---

## Task 7: D1 超额度与 B2 错误的完整错误处理

**Files:** Modify `index.js`（多数已具备 try/catch，本任务补齐并加测试）；Create `test/errors.test.js`

**Step 1: `test/errors.test.js`**

```js
import { SELF, fetchMock, env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import worker from '../index.js'
import { expect, test, beforeAll, afterEach, beforeEach, describe } from 'vitest'
import { resetDb, insertLink, FUTURE, PAST } from './helpers.js'

const ORIGIN = 'https://s3.us-west-004.backblazeb2.com'

beforeAll(() => { fetchMock.activate(); fetchMock.disableNetConnect() })
beforeEach(resetDb)
afterEach(() => { try { fetchMock.assertNoPendingInterceptors() } catch {} })

describe('upstream (B2) errors are sanitized & not cached', () => {
  test('404 -> 404, no B2 body leak', async () => {
    await insertLink('e404', 'b2test', 'missing.png', FUTURE)
    fetchMock.get(ORIGIN).intercept({ path: '/test-bucket/missing.png', method: 'GET' })
      .reply(404, '<Error><Code>NoSuchKey</Code><BucketName>test-bucket</BucketName></Error>', { headers: { 'content-type': 'application/xml' } })
    const res = await SELF.fetch('https://cdn.example.com/s/e404')
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('')
    expect(res.headers.get('cache-control')).toBe('no-store')
  })
  test('5xx -> 502', async () => {
    await insertLink('e503', 'b2test', 'x.png', FUTURE)
    fetchMock.get(ORIGIN).intercept({ path: '/test-bucket/x.png', method: 'GET' }).reply(503, 'down')
    expect((await SELF.fetch('https://cdn.example.com/s/e503')).status).toBe(502)
  })
  test('403 -> 502 (never reveal)', async () => {
    await insertLink('e403', 'b2test', 'x.png', FUTURE)
    fetchMock.get(ORIGIN).intercept({ path: '/test-bucket/x.png', method: 'GET' }).reply(403, 'AccessDenied')
    expect((await SELF.fetch('https://cdn.example.com/s/e403')).status).toBe(502)
  })
})

describe('D1 failure is fail-closed (no upstream fetch)', () => {
  test('resolve throws -> 503', async () => {
    const db = { prepare: () => ({ bind: () => ({ first: () => { throw new Error('D1_ERROR: too many requests') } }) }) }
    const ctx = createExecutionContext()
    const res = await worker.fetch(new Request('https://cdn.example.com/s/whatever'), { ...env, DB: db }, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(503)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })
  test('insert throws -> 503', async () => {
    const db = { prepare: () => ({ bind: () => ({ run: () => { throw new Error('D1_ERROR: quota exceeded') } }) }) }
    const ctx = createExecutionContext()
    const req = new Request('https://cdn.example.com/api/sign', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test-admin-pass' },
      body: JSON.stringify({ bucket: 'b2test', path: '/a.png' }),
    })
    const res = await worker.fetch(req, { ...env, DB: db }, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(503)
  })
})

test('expired link -> 404, no upstream fetch, and lazily deleted', async () => {
  await insertLink('expx', 'b2test', 'x.png', PAST)
  const ctx = createExecutionContext()
  // 未注册 interceptor：若回源会因 disableNetConnect 抛错
  const res = await worker.fetch(new Request('https://cdn.example.com/s/expx'), env, ctx)
  expect(res.status).toBe(404)
  await waitOnExecutionContext(ctx) // flush lazy DELETE
  const row = await env.DB.prepare('SELECT * FROM links WHERE id = ?').bind('expx').first()
  expect(row).toBeNull()
})
```

**Step 2: Run** `npm test -- test/errors.test.js` → Expected: 多数应已 PASS；失败处按下一步补齐。

**Step 3: 复核 `index.js` 错误处理完整性**

逐项确认：每个 `env.DB` 调用都在 try/catch（→503）；惰性删除走 `deleteLinkBestEffort`（永不抛进响应）；每个上游 `fetch` 在 try/catch（→502）；上游非 2xx/206 走 `mapUpstreamError`，**绝不**透传 `resp.body`/`resp.headers`；过期/未知在任何 `fetch` 前返回 404；**交付端**错误分支均 no-store、无 body（管理端 JSON 错误见 Task 3，不含敏感信息）。

**Step 4: Run** `npm test` → Expected: 全 PASS。

**Step 5: Commit** `test(网关): 覆盖 D1 超额度与 B2 错误的 fail-closed 行为`

---

## Task 8: `POST /api/revoke` 撤销短链

> 已确认纳入。撤销立即删除 D1 行，链接随即失效。

**Files:** Modify `index.js`；Create `test/revoke.test.js`

**测试要点**：带 auth 删除存在的 id → `{deleted:true}` 且随后访问 404；无 auth → 401。

**实现**：

```js
const REVOKE_PATH = '/api/revoke'
async function handleRevoke(request, env) {
  if (!(await authenticate(request, env))) return noStore(401, 'Unauthorized')
  let body
  try { body = await request.json() } catch { return jsonResponse({ error: 'invalid json' }, 400) }
  if (typeof body.id !== 'string') return jsonResponse({ error: 'invalid id' }, 400)
  try {
    const res = await env.DB.prepare('DELETE FROM links WHERE id = ?').bind(body.id).run()
    return jsonResponse({ deleted: res.meta.changes > 0 })
  } catch { return noStore(503, 'Service Unavailable') }
}
```

路由（`/api/sign` 之后）：

```js
    if (path === REVOKE_PATH) {
      if (request.method !== 'POST') return noStore(405, 'Method Not Allowed')
      return handleRevoke(request, env)
    }
```

**Commit** `feat(网关): 可选 POST /api/revoke 撤销短链`

---

## Task 9: 定时清理过期行（Cron 批量；惰性已在交付层）

> 惰性清理已在交付层：命中过期行即 best-effort 删除（Task 2/4）。本任务补 Cron 批量清扫**从未被访问**的过期行。

把删除逻辑抽成可单测的纯函数并在 `scheduled` 调用：

```js
export async function cleanupExpired(env) {
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare('DELETE FROM links WHERE exp < ?').bind(now).run()
}
```

`export default` 增加：

```js
  async scheduled(event, env, ctx) {
    ctx.waitUntil(cleanupExpired(env).catch(() => {}))
  },
```

`wrangler.toml` 取消注释 `[triggers] crons = ["0 3 * * *"]`。测试：插入一条 FUTURE 一条 PAST，调 `cleanupExpired(env)` 后只剩 1 条。

**Commit** `feat(网关): 可选 Cron 定时清理过期短链`

---

## Task 10: 文档与收尾

**Files:** Modify `README.md`（重写）、`CHANGELOG.md`

**README 至少包含**：
- 定位与**安全模型**（短链不可枚举、fail-closed、不泄露后端、稳定 bucket id、对象 key 安全编码）。
- 部署：`npm install` → `wrangler d1 create cdn-links`（填 `database_id`）→ `wrangler d1 migrations apply cdn-links`（本地加 `--local`）→ 设 secrets：
  ```bash
  cat buckets.json | npx wrangler secret put BUCKETS
  npx wrangler secret put ADMIN_PASSWORD
  npx wrangler deploy
  ```
  `buckets.json` 示例（数组，每桶一组，含稳定 `id`）：
  ```json
  [{"id":"b2main","name":"1145141919810","endpoint":"s3.us-west-004.backblazeb2.com","region":"us-west-004","keyId":"...","applicationKey":"..."}]
  ```
- 配置表（`CACHE_TTL_SECONDS`/`TOKEN_TTL_SECONDS`/`TOKEN_ID_LENGTH` 及其边界）。
- 生成短链：
  ```bash
  curl -X POST https://cdn.example.com/api/sign \
    -H "authorization: Bearer $ADMIN_PASSWORD" -H "content-type: application/json" \
    -d '{"bucket":"b2main","path":"/path/to/file.png"}'
  # -> {"url":"https://cdn.example.com/s/aB3xK9_qZ1mP7nR2","id":"...","exp":...}  (16 字符 = 默认 TOKEN_ID_LENGTH)
  ```
- 访问示例、Range/视频/多线程说明、**多服务商迁移**（加桶 = 往 `BUCKETS` 加一组带新 `id` 的对象；旧链接不受影响）。
- **安全注意**：无 KV/DO 无法限流，`ADMIN_PASSWORD` 必须长随机；`BUCKETS` 含凭证为最高敏感 secret；D1 仅存 bucket id+key 不存凭证；B2 桶 Bucket Info 设 `{"Cache-Control":"public"}` 才能被 Cloudflare 缓存。

**CHANGELOG**：`[Unreleased]` 加中文条目，注明这是不兼容重大重构。

**收尾**：`npm run format` → `npm test` → `npx wrangler deploy --dry-run`（需 `database_id` 已填）→ 全绿。

**Commit** `docs(网关): 重写 README 与 CHANGELOG`

---

## 最终验收清单（对照原始需求 + 评审修复）

| # | 验收项 | 覆盖 |
|---|---|---|
| 1 | `GET /s/<valid>` 流式返回文件 | Task 4 |
| 2 | 过期短链 → 404、不回源 | Task 7 |
| 3 | 未知/伪造 id → 404 | Task 2/7 |
| 4 | 非白名单桶 id 无法签发 | Task 3 |
| 5 | `GET /real-file.png` → 403、不回源不查缓存 | Task 2 |
| 6 | `GET /<bucket>/key` → 403 | Task 2 |
| 7 | `POST /s/<id>` → 405 | Task 2 |
| 8 | 同文件两短链命中同一内部缓存键 | Task 4 |
| 9 | Range → 206、不写整文件缓存 | Task 5 |
| 10 | 不缓冲：`new Response(body,…)` + pretest 守卫 | Task 1/4/5 |
| 11 | D1 超额度/异常 → 503、fail-closed 不回源 | Task 7 |
| 12 | B2 错误不泄露后端、不缓存 | Task 7 |
| 13 | HEAD（含 +Range）不下载全量、无体 | Task 5/6 |
| 14 | 多线程并行 Range 正确 | Task 5 |
| 15 | **桶用稳定 id，不受重排影响** | Task 1/3/4 |
| 16 | **对象 key 安全编码（`?`/`#`/空格/`%2e%2e`）** | Task 3/4 |
| 17 | **Range 重试耗尽 → 502，绝不返回全量** | Task 5 |
| 18 | **配置/环境变量 schema 校验，fail-closed** | Task 3 |
| 19 | **过期行惰性删除（命中即删）+ Cron 批量清理** | Task 2/4 + Task 9 |

## 部署步骤（实现完成后交你执行）

```bash
npm install
npx wrangler d1 create cdn-links          # 输出的 database_id 填进 wrangler.toml
npx wrangler d1 migrations apply cdn-links # 建表（本地加 --local）
cat buckets.json | npx wrangler secret put BUCKETS
npx wrangler secret put ADMIN_PASSWORD
npx wrangler deploy
# 本地联调：cp .dev.vars.template .dev.vars 填值，npx wrangler dev
```

## 已确认决策

- 未知 / 过期短链都返回 **404**（不给存在性预言机）。
- **清理双保险**：交付层惰性删除（命中过期行即 best-effort `DELETE`，Task 2/4）+ Cron 批量清扫从未被访问的过期行（Task 9）。
- **撤销**（Task 8）纳入。
- **endpoint**：允许任意可连通的 S3 兼容端点——https/http、任意端口均可（裸 host 默认 https）。⚠️ http 明文传输 SigV4 鉴权头与数据，仅可信网络使用；README 安全节会写明。
- `TOKEN_ID_LENGTH` 默认 16（≈96bit）、下限 12（≈72bit）。

## 风险与待确认

1. **aws4fetch 对 S3 路径的编码**：本方案对 key 预先按段 RFC3986 编码后交给 `client.sign`。若 aws4fetch 对 S3 再次编码导致双重编码，Task 4 的「特殊字符」测试会失败暴露；届时改为「传未编码 key、由 aws4fetch 编码」并保留 `?`/`#` 必须预编码（否则 `new URL` 会当 query/fragment）的处理。**部署后务必用真实 B2 验证一个含空格/中文的 key。**
2. **pool 缓存行为**：去重测试依赖 `@cloudflare/vitest-pool-workers` 的 `caches.default` 生效；若该环境为 no-op，标 `.skip` 并改 `wrangler dev` 手验。
3. **测试栈**：引入 `@cloudflare/vitest-pool-workers`（新增 devDeps）。不想要可砍 Task 1 测试部分改手动 curl，但 D1 失败/Range 重试/编码/不缓冲很难手验，强烈建议保留。
```
