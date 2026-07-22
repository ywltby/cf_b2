// B2 私有桶只读代理。SigV4 算法取自 aws4fetch（MIT，Michael Hart 2024）。
const B2_CONFIG = {
  endpoint: 's3.us-west-004.backblazeb2.com',
  bucket: 'replace-with-bucket',
  keyId: 'replace-with-read-only-key-id',
  applicationKey: 'replace-with-read-only-application-key',
}

const CACHE_CONTROL = 'public, max-age=86400'
const SPEED_TEST_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>下载测速</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f4f5f7;
      color: #17191c;
    }
    * { box-sizing: border-box; }
    body {
      min-height: 100vh;
      margin: 0;
      display: grid;
      place-items: center;
      padding: 24px;
      background: #f4f5f7;
    }
    main {
      width: min(100%, 520px);
      padding: 36px;
      border: 1px solid #d9dde3;
      border-radius: 8px;
      background: #fff;
      box-shadow: 0 12px 32px rgb(26 31 38 / 8%);
    }
    h1 {
      margin: 0;
      font-size: 20px;
      font-weight: 650;
    }
    .reading {
      display: flex;
      align-items: baseline;
      gap: 8px;
      margin: 34px 0 24px;
      font-variant-numeric: tabular-nums;
    }
    #speed {
      font-size: clamp(52px, 14vw, 76px);
      line-height: 1;
      font-weight: 700;
    }
    .unit { color: #646b75; }
    .track {
      height: 8px;
      overflow: hidden;
      border-radius: 999px;
      background: #e6e9ed;
    }
    #progress {
      width: 0;
      height: 100%;
      background: #c3272b;
      transition: width 120ms ease-out;
    }
    .details {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      margin: 12px 0 28px;
      color: #646b75;
      font-size: 14px;
      font-variant-numeric: tabular-nums;
    }
    button {
      width: 100%;
      min-height: 46px;
      border: 1px solid #a91f24;
      border-radius: 6px;
      background: #c3272b;
      color: #fff;
      font: inherit;
      font-weight: 650;
      cursor: pointer;
    }
    button:hover { background: #a91f24; }
    button:focus-visible { outline: 3px solid rgb(195 39 43 / 28%); outline-offset: 2px; }
    button:disabled { cursor: wait; opacity: .68; }
    #status {
      min-height: 20px;
      margin: 14px 0 0;
      color: #646b75;
      font-size: 14px;
      text-align: center;
    }
    @media (max-width: 520px) {
      body { padding: 16px; }
      main { padding: 28px 22px; }
    }
    @media (prefers-color-scheme: dark) {
      :root, body { background: #111315; color: #f1f2f4; }
      main { border-color: #34383e; background: #1a1d20; box-shadow: none; }
      .unit, .details, #status { color: #aeb4bc; }
      .track { background: #34383e; }
    }
    @media (prefers-reduced-motion: reduce) {
      #progress { transition: none; }
    }
  </style>
</head>
<body>
  <main>
    <h1>下载测速</h1>
    <div class="reading" aria-live="polite">
      <span id="speed">--</span>
      <span class="unit">Mbps</span>
    </div>
    <div class="track" role="progressbar" aria-label="测速进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
      <div id="progress"></div>
    </div>
    <div class="details">
      <span id="transferred">0 / 100 MiB</span>
      <span id="elapsed">0.0 秒</span>
    </div>
    <button id="start" type="button">开始测速</button>
    <p id="status" role="status">准备就绪</p>
  </main>
  <script>
    const TEST_URL = '/BLM-008.mp4'
    const TOTAL_BYTES = 104857600
    const STREAMS = 4
    const RANGE_BYTES = TOTAL_BYTES / STREAMS
    const speed = document.querySelector('#speed')
    const progress = document.querySelector('#progress')
    const progressbar = document.querySelector('[role="progressbar"]')
    const transferredLabel = document.querySelector('#transferred')
    const elapsedLabel = document.querySelector('#elapsed')
    const statusLabel = document.querySelector('#status')
    const startButton = document.querySelector('#start')
    let transferred = 0
    let startedAt = 0
    let lastPaint = 0

    function paint(force) {
      const now = performance.now()
      if (!force && now - lastPaint < 80) return
      lastPaint = now
      const seconds = Math.max((now - startedAt) / 1000, 0.001)
      const percent = Math.min((transferred / TOTAL_BYTES) * 100, 100)
      speed.textContent = ((transferred * 8) / seconds / 1000000).toFixed(1)
      progress.style.width = percent.toFixed(2) + '%'
      progressbar.setAttribute('aria-valuenow', Math.round(percent))
      transferredLabel.textContent = (transferred / 1048576).toFixed(1) + ' / 100 MiB'
      elapsedLabel.textContent = seconds.toFixed(1) + ' 秒'
    }

    async function downloadRange(index, runId) {
      const first = index * RANGE_BYTES
      const last = first + RANGE_BYTES - 1
      const response = await fetch(TEST_URL + '?speedtest=' + runId + '-' + index, {
        cache: 'no-store',
        headers: { Range: 'bytes=' + first + '-' + last },
      })
      if (response.status !== 206 || !response.body) {
        throw new Error('测速资源未返回分段响应')
      }
      const reader = response.body.getReader()
      while (true) {
        const result = await reader.read()
        if (result.done) break
        transferred += result.value.byteLength
        paint(false)
      }
    }

    startButton.addEventListener('click', async () => {
      transferred = 0
      lastPaint = 0
      startedAt = performance.now()
      speed.textContent = '0.0'
      progress.style.width = '0%'
      progressbar.setAttribute('aria-valuenow', '0')
      transferredLabel.textContent = '0 / 100 MiB'
      elapsedLabel.textContent = '0.0 秒'
      statusLabel.textContent = '测速中'
      startButton.disabled = true
      try {
        const runId = Date.now()
        await Promise.all(Array.from({ length: STREAMS }, (_, index) => downloadRange(index, runId)))
        if (transferred !== TOTAL_BYTES) throw new Error('测速数据不完整')
        paint(true)
        statusLabel.textContent = '测速完成'
        startButton.textContent = '重新测速'
      } catch (error) {
        statusLabel.textContent = error instanceof Error ? error.message : '测速失败'
      } finally {
        startButton.disabled = false
      }
    })
  </script>
</body>
</html>`
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

function speedTestPage(method) {
  return new Response(method === 'HEAD' ? null : SPEED_TEST_HTML, {
    headers: {
      'cache-control': 'no-store',
      'content-security-policy':
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      'content-type': 'text/html; charset=utf-8',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
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

async function fetchObject(request, key) {
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
    await cache.put(cacheKey, response.clone()).catch(() => {})
  }
  return response
}

export default {
  async fetch(request) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return noStore(405, 'Method Not Allowed')
    }

    const pathname = new URL(request.url).pathname
    if (pathname === '/') return speedTestPage(request.method)

    const key = objectKey(pathname)
    if (!key) return noStore(404, 'Not Found')
    return fetchObject(request, key)
  },
}
