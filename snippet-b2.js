// B2 私有桶只读代理。SigV4 算法取自 aws4fetch（MIT，Michael Hart 2024）。
const B2_CONFIG = {
  endpoint: 's3.us-west-004.backblazeb2.com',
  bucket: 'replace-with-bucket',
  keyId: 'replace-with-read-only-key-id',
  applicationKey: 'replace-with-read-only-application-key',
}

const CACHE_CONTROL = 'public, max-age=86400'
const PASS_THROUGH_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'content-disposition',
  'etag',
  'last-modified',
]
const REGION =
  B2_CONFIG.endpoint.match(/^s3\.([\w-]+)\.backblazeb2\.com$/)?.[1] ||
  'us-east-1'
const ENCODER = new TextEncoder()
const SIGNING_KEYS = new Map()

function noStore(status, statusText) {
  return new Response(null, {
    status,
    statusText,
    headers: { 'cache-control': 'no-store' },
  })
}

function objectKey(pathname) {
  const encoded = pathname.slice(1)
  if (!encoded) return null

  const segments = []
  for (const segment of encoded.split('/')) {
    if (!segment) return null

    let decoded
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      return null
    }
    if (
      !decoded ||
      decoded === '.' ||
      decoded === '..' ||
      decoded.includes('\\') ||
      /[\x00-\x1f\x7f]/.test(decoded)
    ) {
      return null
    }
    segments.push(decoded)
  }
  return segments.join('/')
}

function encodeRfc3986(value) {
  return value.replace(
    /[!'()*]/g,
    (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase(),
  )
}

function encodeKey(key) {
  return key
    .split('/')
    .map((segment) => encodeRfc3986(encodeURIComponent(segment)))
    .join('/')
}

function originUrl(key) {
  return `https://${B2_CONFIG.endpoint}/${encodeURIComponent(B2_CONFIG.bucket)}/${encodeKey(key)}`
}

function canonicalPath(url) {
  let decoded
  try {
    decoded = decodeURIComponent(url.pathname.replace(/\+/g, ' '))
  } catch {
    decoded = url.pathname
  }
  return encodeRfc3986(encodeURIComponent(decoded).replace(/%2F/g, '/'))
}

async function signGet(urlString, headersInit) {
  const url = new URL(urlString)
  const headers = new Headers(headersInit)
  const datetime = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '')
  const date = datetime.slice(0, 8)
  const scope = `${date}/${REGION}/s3/aws4_request`
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date'

  headers.set('X-Amz-Content-Sha256', 'UNSIGNED-PAYLOAD')
  headers.set('X-Amz-Date', datetime)

  const canonicalRequest = [
    'GET',
    canonicalPath(url),
    '',
    `host:${url.host}\nx-amz-content-sha256:UNSIGNED-PAYLOAD\nx-amz-date:${datetime}\n`,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n')
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    datetime,
    scope,
    hex(await sha256(canonicalRequest)),
  ].join('\n')
  const signature = hex(await hmac(await signingKey(date), stringToSign))

  headers.set(
    'Authorization',
    `AWS4-HMAC-SHA256 Credential=${B2_CONFIG.keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  )
  return new Request(url, { method: 'GET', headers })
}

async function signingKey(date) {
  let key = SIGNING_KEYS.get(date)
  if (key) return key

  const dateKey = await hmac(`AWS4${B2_CONFIG.applicationKey}`, date)
  const regionKey = await hmac(dateKey, REGION)
  const serviceKey = await hmac(regionKey, 's3')
  key = await hmac(serviceKey, 'aws4_request')
  SIGNING_KEYS.set(date, key)
  return key
}

async function hmac(key, value) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    typeof key === 'string' ? ENCODER.encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return crypto.subtle.sign('HMAC', cryptoKey, ENCODER.encode(value))
}

function sha256(value) {
  return crypto.subtle.digest('SHA-256', ENCODER.encode(value))
}

function hex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function responseHeaders(upstream) {
  const headers = new Headers()
  for (const name of PASS_THROUGH_HEADERS) {
    const value = upstream.get(name)
    if (value !== null) headers.set(name, value)
  }
  headers.set('cache-control', CACHE_CONTROL)
  return headers
}

function cacheRequest(key) {
  return new Request(
    `https://cache.local/${encodeURIComponent(B2_CONFIG.bucket)}/${encodeKey(key)}`,
    { method: 'GET' },
  )
}

async function fetchObject(request, key, ctx) {
  const range = request.headers.get('range')
  let cache
  let cacheKey
  if (request.method === 'GET' && !range) {
    cache = caches.default
    cacheKey = cacheRequest(key)
    try {
      const hit = await cache.match(cacheKey)
      if (hit) return hit
    } catch {}
  }

  const signed = await signGet(originUrl(key), range ? { range } : undefined)
  const upstream = await fetch(signed)
  if (request.method === 'HEAD') {
    upstream.body?.cancel()
    return new Response(null, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.ok
        ? responseHeaders(upstream.headers)
        : upstream.headers,
    })
  }
  if (!upstream.ok) return upstream

  const response = new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders(upstream.headers),
  })
  if (cache && cacheKey) {
    ctx.waitUntil(cache.put(cacheKey, response.clone()).catch(() => {}))
  }
  return response
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return noStore(405, 'Method Not Allowed')
    }

    const key = objectKey(new URL(request.url).pathname)
    if (!key) return noStore(404, 'Not Found')
    return fetchObject(request, key, ctx)
  },
}
