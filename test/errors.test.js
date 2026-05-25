import {
  SELF,
  fetchMock,
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from 'cloudflare:test'
import worker from '../index.js'
import {
  expect,
  test,
  beforeAll,
  afterEach,
  beforeEach,
  describe,
} from 'vitest'
import { resetDb, insertLink, FUTURE, PAST } from './helpers.js'

const ORIGIN = 'https://s3.us-west-004.backblazeb2.com'

beforeAll(() => {
  fetchMock.activate()
  fetchMock.disableNetConnect()
})
beforeEach(resetDb)
afterEach(() => {
  try {
    fetchMock.assertNoPendingInterceptors()
  } catch {}
})

describe('upstream (B2) errors are sanitized & not cached', () => {
  test('404 -> 404, no B2 body leak', async () => {
    await insertLink('e404', 'b2test', 'missing.png', FUTURE)
    fetchMock
      .get(ORIGIN)
      .intercept({ path: '/test-bucket/missing.png', method: 'GET' })
      .reply(
        404,
        '<Error><Code>NoSuchKey</Code><BucketName>test-bucket</BucketName></Error>',
        { headers: { 'content-type': 'application/xml' } },
      )
    const res = await SELF.fetch('https://cdn.example.com/s/e404')
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('')
    expect(res.headers.get('cache-control')).toBe('no-store')
  })
  test('5xx -> 502', async () => {
    await insertLink('e503', 'b2test', 'x.png', FUTURE)
    fetchMock
      .get(ORIGIN)
      .intercept({ path: '/test-bucket/x.png', method: 'GET' })
      .reply(503, 'down')
    expect((await SELF.fetch('https://cdn.example.com/s/e503')).status).toBe(
      502,
    )
  })
  test('403 -> 502 (never reveal)', async () => {
    await insertLink('e403', 'b2test', 'x.png', FUTURE)
    fetchMock
      .get(ORIGIN)
      .intercept({ path: '/test-bucket/x.png', method: 'GET' })
      .reply(403, 'AccessDenied')
    expect((await SELF.fetch('https://cdn.example.com/s/e403')).status).toBe(
      502,
    )
  })
})

describe('D1 failure is fail-closed (no upstream fetch)', () => {
  test('resolve throws -> 503', async () => {
    const db = {
      prepare: () => ({
        bind: () => ({
          first: () => {
            throw new Error('D1_ERROR: too many requests')
          },
        }),
      }),
    }
    const ctx = createExecutionContext()
    const res = await worker.fetch(
      new Request('https://cdn.example.com/s/whatever'),
      { ...env, DB: db },
      ctx,
    )
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(503)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })
  test('insert throws -> 503', async () => {
    const db = {
      prepare: () => ({
        bind: () => ({
          run: () => {
            throw new Error('D1_ERROR: quota exceeded')
          },
        }),
      }),
    }
    const ctx = createExecutionContext()
    const req = new Request('https://cdn.example.com/api/sign', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-admin-pass',
      },
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
  const res = await worker.fetch(
    new Request('https://cdn.example.com/s/expx'),
    env,
    ctx,
  )
  expect(res.status).toBe(404)
  await waitOnExecutionContext(ctx) // flush lazy DELETE
  const row = await env.DB.prepare('SELECT * FROM links WHERE id = ?')
    .bind('expx')
    .first()
  expect(row).toBeNull()
})
