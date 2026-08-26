import { AwsClient } from 'aws4fetch'

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

function requestedDownloadFilename(request) {
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
  return 502
}

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
      attempts -= 1
      if (attempts > 0) {
        controller.abort()
        continue
      }
    }
    break
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
  const cacheTtl = intVar(env, 'CACHE_TTL_SECONDS', 86400, 0, 31536000)
  const cacheControl =
    cacheTtl === 0 ? 'no-store' : `public, max-age=${cacheTtl}`

  const isHead = request.method === 'HEAD'
  const rangeHeader = request.headers.get('range')

  if (rangeHeader) {
    let resp
    try {
      resp = await fetchRange(client, url, rangeHeader)
    } catch {
      return noStore(502, 'Bad Gateway')
    }
    if (resp.status !== 206) {
      await resp.body?.cancel().catch(() => {})
      if (resp.status === 416) return noStore(416, 'Range Not Satisfiable')
      return noStore(
        resp.status >= 400 ? mapUpstreamError(resp.status) : 502,
        'Bad Gateway',
      )
    }
    const headers = sanitizeHeaders(resp.headers, cacheControl)
    if (isHead) {
      await resp.body?.cancel().catch(() => {})
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
  if (cacheIdentity && cacheTtl > 0) {
    cache = caches.default
    cacheKey = new Request(
      `https://cache.local/${encodeURIComponent(cacheIdentity)}/${encodeURIComponent(key)}`,
      { method: 'GET' },
    )
    try {
      const hit = await cache.match(cacheKey)
      if (hit) return asDownload(hit, downloadFilename)
    } catch {
      // Treat cache errors as misses.
    }
  }

  let resp
  try {
    resp = await fetch(await client.sign(url, { method: 'GET' }))
  } catch {
    return noStore(502, 'Bad Gateway')
  }
  if (!resp.ok) {
    await resp.body?.cancel().catch(() => {})
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

function intVar(env, name, def, min, max) {
  const raw = env[name]
  if (typeof raw !== 'string' || !/^(0|[1-9]\d*)$/.test(raw)) return def
  const n = Number(raw)
  return n >= min && n <= max ? n : def
}

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
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error('bucket endpoint scheme invalid')
  }
  if (u.pathname !== '/' || u.search || u.hash || u.username || u.password) {
    throw new Error('bucket endpoint must be origin only')
  }
  return u.origin
}

let bucketsRaw = null
let bucketsById = null

function getBuckets(env) {
  const raw = env.BUCKETS
  if (!raw) throw new Error('BUCKETS not configured')
  if (raw !== bucketsRaw) {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('BUCKETS must be a non-empty array')
    }
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
      if (!BUCKET_ID_RE.test(c.id)) {
        throw new Error('bucket id charset invalid')
      }
      const origin = parseEndpoint(c.endpoint)
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
    bucketsById = byId
    bucketsRaw = raw
  }
  return bucketsById
}

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

function decodePathKey(pathname) {
  try {
    return pathname
      .slice(1)
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/')
  } catch {
    return null
  }
}

async function handlePublicBucket(request, env, ctx, rawKey, bucketId) {
  const key = normalizeKey(rawKey)
  if (!key) return noStore(404, 'Not Found')

  if (typeof bucketId !== 'string' || !BUCKET_ID_RE.test(bucketId)) {
    return noStore(500, 'Server Error')
  }

  let buckets
  try {
    buckets = getBuckets(env)
  } catch {
    return noStore(500, 'Server Error')
  }

  const cfg = buckets.get(bucketId)
  if (!cfg) return noStore(500, 'Server Error')

  return deliverOriginObject(request, env, ctx, cfg, key, bucketId)
}

export {
  decodePathKey,
  deliverOriginObject,
  getBuckets,
  handlePublicBucket,
  intVar,
  normalizeKey,
  noStore,
  parseEndpoint,
  requestedDownloadFilename,
}
