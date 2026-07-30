import { AwsClient } from 'aws4fetch'

const ID_ROUTE = /^\/s\/([A-Za-z0-9_-]{1,64})$/
const B_ROUTE = /^\/b\/(.+)$/
const CHAPTER_CONTENT_ROUTE = /^\/chapter-content\/(.+)$/
const BOOK_EXPORT_ROUTE = /^\/book-export\/(.+)$/
const SIGN_PATH = '/api/sign'
const REVOKE_PATH = '/api/revoke'
const BUCKET_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const PASS_THROUGH_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified',
]
const RANGE_RETRY_ATTEMPTS = 3

function noStore(status, statusText) {
  return new Response(null, {
    status,
    statusText,
    headers: { 'cache-control': 'no-store' },
  })
}

async function resolveLink(env, id) {
  // throws on D1 errors; caller maps to 503
  return env.DB.prepare('SELECT bucket_id, p, exp FROM links WHERE id = ?')
    .bind(id)
    .first()
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
    .map((s) =>
      encodeURIComponent(s).replace(
        /[!*'()]/g,
        (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
      ),
    )
    .join('/')
}
function buildOriginUrl(cfg, key) {
  return `${cfg.origin}/${encodeURIComponent(cfg.name)}/${encodeKey(key)}`
}
function makeClient(cfg) {
  return new AwsClient({
    accessKeyId: cfg.keyId,
    secretAccessKey: cfg.applicationKey,
    service: 's3',
    region: cfg.region,
  })
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

function downloadDisposition(filename) {
  const dot = filename.lastIndexOf('.')
  const extension =
    dot > 0 && /^\.[A-Za-z0-9.]{1,20}$/.test(filename.slice(dot))
      ? filename.slice(dot)
      : ''
  const stem = extension ? filename.slice(0, -extension.length) : filename
  const asciiStem = stem
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/["\\;]/g, '_')
    .trim()
  const fallback = /[A-Za-z0-9]/.test(asciiStem) ? asciiStem : 'download'
  const encoded = encodeURIComponent(filename).replace(
    /[!'()*]/g,
    (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase(),
  )
  return `attachment; filename="${fallback.slice(0, 120)}${extension}"; filename*=UTF-8''${encoded}`
}

export function requestedDownloadFilename(request) {
  const filename = new URL(request.url).searchParams.get('filename')
  if (
    !filename ||
    filename !== filename.trim() ||
    new TextEncoder().encode(filename).length > 255 ||
    /[\u0000-\u001f\u007f/\\]/.test(filename)
  ) {
    return ''
  }
  return filename
}

function asDownload(response, filename) {
  if (!filename) return response
  const headers = new Headers(response.headers)
  headers.set('content-disposition', downloadDisposition(filename))
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function mapUpstreamError(status) {
  if (status === 404) return 404
  if (status === 416) return 416
  return 502 // 403/401/其它 4xx/5xx 一律泛化为网关错误，绝不泄露
}

// Large-file Cloudflare workaround: if a range request comes back 200 (range
// ignored) instead of 206, abort and retry. See original cloudflare-b2 README.
async function fetchRange(client, url, rangeHeader) {
  const signed = await client.sign(url, {
    method: 'GET',
    headers: { range: rangeHeader },
  })
  let attempts = RANGE_RETRY_ATTEMPTS
  let response
  do {
    const controller = new AbortController()
    response = await fetch(signed.url, {
      method: 'GET',
      headers: signed.headers,
      signal: controller.signal,
    })
    if (response.status === 206) break
    if (response.ok) {
      // 200 = range ignored: discard the wrong full body and retry
      attempts -= 1
      if (attempts > 0) {
        controller.abort()
        continue
      }
    }
    break // 206 handled above; upstream error or exhausted retries fall through
  } while (attempts > 0)
  return response
}

async function deliverOriginObject(
  request,
  env,
  ctx,
  cfg,
  key,
  cacheIdentity,
  downloadFilename,
) {
  const url = buildOriginUrl(cfg, key)
  const client = makeClient(cfg)
  const cacheControl = `public, max-age=${intVar(env, 'CACHE_TTL_SECONDS', 86400, 0, 31536000)}`

  const isHead = request.method === 'HEAD'
  const rangeHeader = request.headers.get('range')

  // RANGE: bypass cache, strict 206 (never return a full 200 to a Range request)
  if (rangeHeader) {
    let resp
    try {
      resp = await fetchRange(client, url, rangeHeader)
    } catch {
      return noStore(502, 'Bad Gateway')
    }
    if (resp.status !== 206) {
      resp.body?.cancel()
      if (resp.status === 416) return noStore(416, 'Range Not Satisfiable')
      return noStore(
        resp.status >= 400 ? mapUpstreamError(resp.status) : 502,
        'Bad Gateway',
      )
    }
    const headers = sanitizeHeaders(resp.headers, cacheControl)
    if (isHead) {
      resp.body?.cancel()
      return asDownload(
        new Response(null, { status: 206, headers }),
        downloadFilename,
      )
    }
    return asDownload(
      new Response(resp.body, { status: 206, headers }),
      downloadFilename,
    )
  }

  // HEAD (no range): sign GET (issue #18), capture headers, abort body (no full download)
  if (isHead) {
    try {
      const controller = new AbortController()
      const signed = await client.sign(url, { method: 'GET' })
      const resp = await fetch(signed.url, {
        method: 'GET',
        headers: signed.headers,
        signal: controller.signal,
      })
      const headers = sanitizeHeaders(resp.headers, cacheControl)
      const status = resp.status
      controller.abort()
      if (!resp.ok) return noStore(mapUpstreamError(status), 'Upstream Error')
      return asDownload(
        new Response(null, { status, headers }),
        downloadFilename,
      )
    } catch {
      return noStore(502, 'Bad Gateway')
    }
  }

  let cache
  let cacheKey
  if (cacheIdentity) {
    cache = caches.default
    cacheKey = new Request(
      `https://cache.local/${encodeURIComponent(cacheIdentity)}/${encodeURIComponent(key)}`,
      { method: 'GET' },
    )
    try {
      const hit = await cache.match(cacheKey)
      if (hit) return asDownload(hit, downloadFilename)
    } catch {
      /* treat as miss */
    }
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

  const response = new Response(resp.body, {
    status: 200,
    headers: sanitizeHeaders(resp.headers, cacheControl),
  })
  if (cache && cacheKey) {
    ctx.waitUntil(cache.put(cacheKey, response.clone()).catch(() => {}))
  }
  return asDownload(response, downloadFilename)
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
  if (row.exp !== 0 && row.exp < now) {
    deleteLinkBestEffort(ctx, env, id) // lazy cleanup; never blocks / never throws into response
    return noStore(404, 'Not Found')
  }

  let buckets
  try {
    buckets = getBuckets(env)
  } catch {
    return noStore(500, 'Server Error')
  }
  let cfg = buckets.get(row.bucket_id)
  const key = normalizeKey(row.p)
  if (!cfg || !key) return noStore(404, 'Not Found')
  if (
    row.bucket_id === env.BOOK_EXPORT_BUCKET_ID &&
    key.startsWith('book-export/')
  ) {
    if (
      typeof env.BOOK_EXPORT_KEY_ID !== 'string' ||
      env.BOOK_EXPORT_KEY_ID.length === 0 ||
      typeof env.BOOK_EXPORT_APPLICATION_KEY !== 'string' ||
      env.BOOK_EXPORT_APPLICATION_KEY.length === 0
    ) {
      return noStore(500, 'Server Error')
    }
    cfg = {
      ...cfg,
      keyId: env.BOOK_EXPORT_KEY_ID,
      applicationKey: env.BOOK_EXPORT_APPLICATION_KEY,
    }
  }

  return deliverOriginObject(
    request,
    env,
    ctx,
    cfg,
    key,
    row.bucket_id,
    requestedDownloadFilename(request) || key.slice(key.lastIndexOf('/') + 1),
  )
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
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
  const e = /^https?:\/\//i.test(endpoint.trim())
    ? endpoint.trim()
    : 'https://' + endpoint.trim()
  let u
  try {
    u = new URL(e)
  } catch {
    throw new Error('bucket endpoint invalid')
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:')
    throw new Error('bucket endpoint scheme invalid')
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
    if (!Array.isArray(parsed) || parsed.length === 0)
      throw new Error('BUCKETS must be a non-empty array')
    const byId = new Map()
    for (const c of parsed) {
      for (const f of [
        'id',
        'name',
        'endpoint',
        'region',
        'keyId',
        'applicationKey',
      ]) {
        if (
          typeof c?.[f] !== 'string' ||
          c[f].length === 0 ||
          c[f].length > 1024
        ) {
          throw new Error(`bucket field invalid: ${f}`)
        }
      }
      if (!BUCKET_ID_RE.test(c.id)) throw new Error('bucket id charset invalid') // id flows into D1/logs/URLs
      const origin = parseEndpoint(c.endpoint) // throws on invalid scheme/host/port
      if (byId.has(c.id)) throw new Error('duplicate bucket id')
      byId.set(c.id, {
        id: c.id,
        name: c.name,
        origin,
        region: c.region,
        keyId: c.keyId,
        applicationKey: c.applicationKey,
      })
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

function normalizePrefix(input) {
  let prefix = input
  if (typeof prefix !== 'string' || prefix.length === 0) return null
  prefix = prefix.startsWith('/') ? prefix.slice(1) : prefix
  if (!prefix.endsWith('/')) prefix += '/'
  const inner = prefix.slice(0, -1)
  const normalized = normalizeKey(inner)
  return normalized ? `${normalized}/` : null
}

async function handlePublicBucket(
  request,
  env,
  ctx,
  rawKey,
  bucketId,
  rawPrefix,
  credentials,
) {
  const key = normalizeKey(rawKey)
  if (!key) return noStore(404, 'Not Found')

  if (typeof bucketId !== 'string' || !BUCKET_ID_RE.test(bucketId)) {
    return noStore(500, 'Server Error')
  }

  const prefix = normalizePrefix(rawPrefix)
  if (!prefix) return noStore(500, 'Server Error')

  let buckets
  try {
    buckets = getBuckets(env)
  } catch {
    return noStore(500, 'Server Error')
  }

  let cfg = buckets.get(bucketId)
  if (!cfg) return noStore(500, 'Server Error')
  if (credentials !== undefined) {
    if (
      typeof credentials.keyId !== 'string' ||
      credentials.keyId.length === 0 ||
      typeof credentials.applicationKey !== 'string' ||
      credentials.applicationKey.length === 0
    ) {
      return noStore(500, 'Server Error')
    }
    cfg = {
      ...cfg,
      keyId: credentials.keyId,
      applicationKey: credentials.applicationKey,
    }
  }

  return deliverOriginObject(
    request,
    env,
    ctx,
    cfg,
    `${prefix}${key}`,
    bucketId,
  )
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
  const m = (request.headers.get('authorization') || '').match(
    /^Bearer\s+(.+)$/,
  )
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

  if (body.permanent !== undefined && typeof body.permanent !== 'boolean') {
    return jsonResponse({ error: 'invalid permanent' }, 403)
  }
  const permanent = body.permanent === true
  if (permanent && body.expiresIn !== undefined) {
    return jsonResponse({ error: 'expiresIn conflicts with permanent' }, 403)
  }

  let exp
  if (permanent) {
    exp = 0
  } else {
    let ttl = intVar(env, 'TOKEN_TTL_SECONDS', 3600, 1, 31536000)
    if (body.expiresIn !== undefined) {
      if (
        !Number.isInteger(body.expiresIn) ||
        body.expiresIn <= 0 ||
        body.expiresIn > 31536000
      ) {
        return jsonResponse({ error: 'invalid expiresIn' }, 403)
      }
      ttl = body.expiresIn
    }
    exp = Math.floor(Date.now() / 1000) + ttl
  }
  const idLen = intVar(env, 'TOKEN_ID_LENGTH', 16, 12, 64) // floor 12 (~72bit); unguessable, no rate limit

  let id
  for (let i = 0; i < 5; i++) {
    id = generateId(idLen)
    try {
      await env.DB.prepare(
        'INSERT INTO links (id, bucket_id, p, exp) VALUES (?, ?, ?, ?)',
      )
        .bind(id, body.bucket, key, exp)
        .run()
      break
    } catch (e) {
      if (String(e?.message).includes('UNIQUE') && i < 4) continue
      return noStore(503, 'Service Unavailable') // D1 quota / error
    }
  }
  const origin = new URL(request.url).origin
  const url = `${origin}/s/${id}`
  return permanent
    ? jsonResponse({ url, id, exp: null, permanent: true })
    : jsonResponse({ url, id, exp })
}

// ---- revoke ----
async function handleRevoke(request, env) {
  if (!(await authenticate(request, env))) return noStore(401, 'Unauthorized')
  let body
  try {
    body = await request.json()
  } catch {
    return jsonResponse({ error: 'invalid json' }, 400)
  }
  if (typeof body.id !== 'string')
    return jsonResponse({ error: 'invalid id' }, 400)
  try {
    const res = await env.DB.prepare('DELETE FROM links WHERE id = ?')
      .bind(body.id)
      .run()
    return jsonResponse({ deleted: res.meta.changes > 0 })
  } catch {
    return noStore(503, 'Service Unavailable')
  }
}

// ---- cleanup (Cron) ----
export async function cleanupExpired(env) {
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare('DELETE FROM links WHERE exp > 0 AND exp < ?')
    .bind(now)
    .run()
}

// Admin signing UI (static, no secrets; same-origin POST to /api/sign).
const ADMIN_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>短链签发</title>
<style>
  :root { color-scheme: dark light; }
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 16px; }
  h1 { font-size: 20px; }
  label { display:block; margin: 14px 0 4px; font-size: 13px; color:#888; }
  input { width:100%; box-sizing:border-box; padding:10px; font-size:14px; border:1px solid #999; border-radius:8px; background:transparent; color:inherit; }
  .check { display:flex; align-items:center; gap:8px; color:inherit; }
  .check input { width:auto; }
  button { margin-top:18px; padding:10px 18px; font-size:15px; border:0; border-radius:8px; background:#3b82f6; color:#fff; cursor:pointer; }
  button:disabled { opacity:.5; cursor:default; }
  #out { margin-top:20px; padding:14px; border-radius:8px; word-break:break-all; font-size:14px; display:none; }
  #out.ok { background:rgba(34,197,94,.14); }
  #out.err { background:rgba(239,68,68,.14); }
  #link { font-weight:600; }
  small { color:#888; }
</style>
</head>
<body>
<h1>短链签发</h1>
<label>管理员密码</label>
<input id="pw" type="password" autocomplete="current-password" placeholder="ADMIN_PASSWORD">
<label>桶 id</label>
<input id="bucket" placeholder="BUCKETS 里的 id">
<label>对象 key（桶里真实文件路径，前导 / 可省略）</label>
<input id="path" placeholder="path/to/file.png">
<label>有效期（秒，留空用默认）</label>
<input id="ttl" type="number" min="1" placeholder="默认 TOKEN_TTL_SECONDS">
<label class="check"><input id="permanent" type="checkbox">永久链接</label>
<button id="go">生成短链</button>
<div id="out"></div>
<script>
(function(){
  var $=function(id){return document.getElementById(id)};
  try { $('bucket').value = localStorage.getItem('cf_b2_bucket') || ''; } catch(e){}
  var out=$('out');
  var ttlInput=$('ttl'), permanentInput=$('permanent');
  function show(ok, html){ out.style.display='block'; out.className=ok?'ok':'err'; out.innerHTML=html; }
  permanentInput.addEventListener('change', function(){
    ttlInput.disabled = permanentInput.checked;
    if (permanentInput.checked) ttlInput.value = '';
  });
  $('go').addEventListener('click', async function(){
    var pw=$('pw').value, bucket=$('bucket').value.trim(), path=$('path').value.trim(), ttl=ttlInput.value.trim(), permanent=permanentInput.checked;
    if(!pw||!bucket||!path){ show(false,'密码、桶 id、对象 key 都要填'); return; }
    try { localStorage.setItem('cf_b2_bucket', bucket); } catch(e){}
    var body={ bucket: bucket, path: path };
    if(permanent) body.permanent = true;
    else if(ttl) body.expiresIn = parseInt(ttl,10);
    $('go').disabled=true; show(true,'生成中…');
    try{
      var r=await fetch('/api/sign',{ method:'POST', headers:{ 'authorization':'Bearer '+pw, 'content-type':'application/json' }, body: JSON.stringify(body) });
      if(r.ok){
        var j=await r.json();
        var exp=j.permanent ? '永久' : new Date(j.exp*1000).toLocaleString();
        show(true, '<div id="link">'+j.url+'</div><div style="margin-top:10px"><button id="cp" type="button">复制</button> <small>过期：'+exp+'</small></div>');
        $('cp').addEventListener('click', function(){ navigator.clipboard.writeText(j.url); $('cp').textContent='已复制'; });
      } else {
        var t=await r.text();
        var msg = r.status===401 ? '密码错误' : (r.status===403 ? '桶 id 不在白名单 / 路径非法' : (r.status===500 ? '服务端配置错误' : ('失败 '+r.status)));
        show(false, msg + (t ? ' — '+t : ''));
      }
    }catch(e){ show(false,'请求出错：'+e.message); }
    finally{ $('go').disabled=false; }
  });
})();
</script>
</body>
</html>`

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname

    if (path === SIGN_PATH) {
      if (request.method !== 'POST') return noStore(405, 'Method Not Allowed')
      return handleSign(request, env)
    }

    if (path === REVOKE_PATH) {
      if (request.method !== 'POST') return noStore(405, 'Method Not Allowed')
      return handleRevoke(request, env)
    }

    if (path === (env.ADMIN_PAGE_PATH || '/admin')) {
      if (request.method !== 'GET') return noStore(405, 'Method Not Allowed')
      return new Response(ADMIN_HTML, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-robots-tag': 'noindex',
        },
      })
    }

    const b = path.match(B_ROUTE)
    if (b) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return noStore(405, 'Method Not Allowed')
      }
      return handlePublicBucket(
        request,
        env,
        ctx,
        b[1],
        env.B_BUCKET_ID,
        env.B_PREFIX,
      )
    }

    const chapterContent = path.match(CHAPTER_CONTENT_ROUTE)
    if (chapterContent) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return noStore(405, 'Method Not Allowed')
      }
      return handlePublicBucket(
        request,
        env,
        ctx,
        chapterContent[1],
        env.CHAPTER_CONTENT_BUCKET_ID,
        'chapter-content/',
      )
    }

    const bookExport = path.match(BOOK_EXPORT_ROUTE)
    if (bookExport) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return noStore(405, 'Method Not Allowed')
      }
      return handlePublicBucket(
        request,
        env,
        ctx,
        bookExport[1],
        env.BOOK_EXPORT_BUCKET_ID,
        'book-export/',
        {
          keyId: env.BOOK_EXPORT_KEY_ID,
          applicationKey: env.BOOK_EXPORT_APPLICATION_KEY,
        },
      )
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

  async scheduled(event, env, ctx) {
    ctx.waitUntil(cleanupExpired(env).catch(() => {}))
  },
}
