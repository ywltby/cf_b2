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

export function speedTestPage(method) {
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
