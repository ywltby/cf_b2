import {
  deliverOriginObject,
  getBuckets,
  intVar,
  normalizeKey,
  noStore,
  parseEndpoint,
  requestedDownloadFilename,
} from './b2.js'

const ID_ROUTE = /^\/s\/([A-Za-z0-9_-]{1,64})$/
const SIGN_PATH = '/api/sign'
const REVOKE_PATH = '/api/revoke'
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
  const cfg = buckets.get(row.bucket_id)
  const key = normalizeKey(row.p)
  if (!cfg || !key) return noStore(404, 'Not Found')

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

  let origin
  try {
    origin = env.PUBLIC_BASE_URL
      ? parseEndpoint(env.PUBLIC_BASE_URL)
      : new URL(request.url).origin
  } catch {
    return jsonResponse({ error: 'server misconfigured' }, 500)
  }

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

    if (path === '/admin') {
      if (request.method !== 'GET') return noStore(405, 'Method Not Allowed')
      return new Response(ADMIN_HTML, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-robots-tag': 'noindex',
        },
      })
    }

    const m = path.match(ID_ROUTE)
    if (m) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return noStore(405, 'Method Not Allowed')
      }
      return handleDeliver(request, env, ctx, m[1])
    }

    return noStore(404, 'Not Found')
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(cleanupExpired(env).catch(() => {}))
  },
}
