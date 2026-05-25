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
