import { AwsClient } from 'aws4fetch'

const ID_ROUTE = /^\/s\/([A-Za-z0-9_-]{1,64})$/
const SIGN_PATH = '/api/sign'
const PASS_THROUGH_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']

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

// ---- origin (S3-compatible) ----
function encodeKey(key) {
  return key
    .split('/')
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
  return 502 // 403/401/其它 4xx/5xx 一律泛化为网关错误，绝不泄露
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

  let buckets
  try {
    buckets = getBuckets(env)
  } catch {
    return noStore(500, 'Server Error')
  }
  const cfg = buckets.get(row.bucket_id)
  const key = normalizeKey(row.p)
  if (!cfg || !key) return noStore(404, 'Not Found')

  const url = buildOriginUrl(cfg, key)
  const client = makeClient(cfg)
  const cacheControl = `public, max-age=${intVar(env, 'CACHE_TTL_SECONDS', 86400, 0, 31536000)}`

  // (Range branch added in Task 5; HEAD branch in Task 6)

  const cache = caches.default
  const cacheKey = new Request(
    `https://cache.local/${encodeURIComponent(row.bucket_id)}/${encodeURIComponent(key)}`,
    { method: 'GET' },
  )
  try {
    const hit = await cache.match(cacheKey)
    if (hit) return hit
  } catch {
    /* treat as miss */
  }

  let resp
  try {
    resp = await fetch(await client.sign(url, { method: 'GET' }))
  } catch {
    return noStore(502, 'Bad Gateway')
  }
  if (!resp.ok) {
    resp.body?.cancel() // release upstream error-body resources; never forward it
    return noStore(mapUpstreamError(resp.status), 'Upstream Error')
  }

  const response = new Response(resp.body, { status: 200, headers: sanitizeHeaders(resp.headers, cacheControl) })
  ctx.waitUntil(cache.put(cacheKey, response.clone()).catch(() => {}))
  return response
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
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
  const va = new Uint8Array(ha)
  const vb = new Uint8Array(hb)
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
  try {
    body = await request.json()
  } catch {
    return jsonResponse({ error: 'invalid json' }, 400)
  }

  let buckets
  try {
    buckets = getBuckets(env)
  } catch {
    return jsonResponse({ error: 'server misconfigured' }, 500)
  }

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
        .bind(id, body.bucket, key, exp)
        .run()
      break
    } catch (e) {
      if (String(e?.message).includes('UNIQUE') && i < 4) continue
      return noStore(503, 'Service Unavailable') // D1 quota / error
    }
  }
  const origin = new URL(request.url).origin
  return jsonResponse({ url: `${origin}/s/${id}`, id, exp })
}

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname

    if (path === SIGN_PATH) {
      if (request.method !== 'POST') return noStore(405, 'Method Not Allowed')
      return handleSign(request, env)
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
