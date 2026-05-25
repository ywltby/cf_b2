import {
  SELF,
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from 'cloudflare:test'
import worker from '../index.js'
import { expect, test, beforeEach, describe } from 'vitest'
import { resetDb } from './helpers.js'

beforeEach(resetDb)
const AUTH = {
  'content-type': 'application/json',
  authorization: 'Bearer test-admin-pass',
}

async function sign(body, headers = AUTH) {
  return SELF.fetch('https://cdn.example.com/api/sign', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

describe('POST /api/sign', () => {
  test('missing / wrong auth -> 401', async () => {
    expect(
      (
        await sign(
          { bucket: 'b2test', path: '/a.png' },
          { 'content-type': 'application/json' },
        )
      ).status,
    ).toBe(401)
    expect(
      (
        await sign(
          { bucket: 'b2test', path: '/a.png' },
          { 'content-type': 'application/json', authorization: 'Bearer nope' },
        )
      ).status,
    ).toBe(401)
  })

  test('valid -> 200 with url/id/exp and a D1 row (normalized key, stable bucket id)', async () => {
    const res = await sign({ bucket: 'b2test', path: '/a.png' })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.url).toMatch(
      /^https:\/\/cdn\.example\.com\/s\/[A-Za-z0-9_-]{12}$/,
    )
    expect(json.id).toHaveLength(12)
    expect(json.exp).toBeGreaterThan(Math.floor(Date.now() / 1000))
    const row = await env.DB.prepare('SELECT * FROM links WHERE id = ?')
      .bind(json.id)
      .first()
    expect(row).toMatchObject({ bucket_id: 'b2test', p: 'a.png' }) // 前导斜杠被规范化掉
  })

  test('expiresIn override honored', async () => {
    const before = Math.floor(Date.now() / 1000)
    const { exp } = await (
      await sign({ bucket: 'b2test', path: '/a.png', expiresIn: 60 })
    ).json()
    expect(exp).toBeGreaterThanOrEqual(before + 60)
    expect(exp).toBeLessThanOrEqual(before + 61)
  })

  test('unknown bucket id -> 403', async () => {
    expect((await sign({ bucket: 'nope', path: '/a.png' })).status).toBe(403)
    expect((await sign({ bucket: 0, path: '/a.png' })).status).toBe(403) // 下标不再被接受
  })

  test('invalid key -> 403', async () => {
    for (const p of [
      '../etc',
      '/a/../b',
      '',
      '/',
      '/a/./b',
      '/a\\b',
      '/a//b',
    ]) {
      expect((await sign({ bucket: 'b2test', path: p })).status, p).toBe(403)
    }
  })

  test('literal %2e%2e is accepted as a literal key (not traversal)', async () => {
    expect(
      (await sign({ bucket: 'b2test', path: '/%2e%2e/x.png' })).status,
    ).toBe(200)
  })

  test('invalid expiresIn -> 403', async () => {
    for (const e of [0, -1, 1.5, 'x', 31536001]) {
      expect(
        (await sign({ bucket: 'b2test', path: '/a.png', expiresIn: e })).status,
        String(e),
      ).toBe(403)
    }
  })

  test('invalid json -> 400', async () => {
    const res = await SELF.fetch('https://cdn.example.com/api/sign', {
      method: 'POST',
      headers: AUTH,
      body: 'not json',
    })
    expect(res.status).toBe(400)
  })

  test('disabled when ADMIN_PASSWORD unset -> 401', async () => {
    const ctx = createExecutionContext()
    const req = new Request('https://cdn.example.com/api/sign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bucket: 'b2test', path: '/a.png' }),
    })
    const res = await worker.fetch(
      req,
      { ...env, ADMIN_PASSWORD: undefined },
      ctx,
    )
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
      const req = new Request('https://cdn.example.com/api/sign', {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ bucket: 'b2test', path: '/a.png' }),
      })
      const res = await worker.fetch(req, { ...env, BUCKETS }, ctx)
      await waitOnExecutionContext(ctx)
      expect(res.status, BUCKETS).toBe(500)
    }
  })
})
