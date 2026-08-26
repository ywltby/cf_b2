import {
  env,
  fetchMock,
  createExecutionContext,
  waitOnExecutionContext,
} from 'cloudflare:test'
import worker from '../src/mapper.js'
import { afterEach, beforeAll, expect, test } from 'vitest'

const ORIGIN = 'https://s3.us-west-004.backblazeb2.com'

beforeAll(() => {
  fetchMock.activate()
  fetchMock.disableNetConnect()
})

afterEach(() => fetchMock.assertNoPendingInterceptors())

test('returns 404 for the empty root key without contacting B2', async () => {
  const response = await worker.fetch(
    new Request('https://s.514996.xyz/'),
    env,
    createExecutionContext(),
  )

  expect(response.status).toBe(404)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.text()).toBe('')
})

test('rejects writes on direct paths without contacting B2', async () => {
  const response = await worker.fetch(
    new Request('https://s.514996.xyz/', { method: 'POST' }),
    env,
    createExecutionContext(),
  )

  expect(response.status).toBe(405)
  expect(response.headers.get('cache-control')).toBe('no-store')
})

test('maps unmatched URL paths directly to the configured B2 bucket', async () => {
  fetchMock
    .get(ORIGIN)
    .intercept({
      path: '/test-bucket/folder-a/folder-b/object-123',
      method: 'GET',
      headers: {
        authorization: /Credential=test-key-id\//,
      },
    })
    .reply(200, 'OBJECT DATA', {
      headers: {
        'content-type': 'application/octet-stream',
        'x-amz-request-id': 'must-not-leak',
      },
    })

  const ctx = createExecutionContext()
  const response = await worker.fetch(
    new Request('https://s.514996.xyz/folder-a/folder-b/object-123'),
    env,
    ctx,
  )
  await waitOnExecutionContext(ctx)

  expect(response.status).toBe(200)
  expect(await response.text()).toBe('OBJECT DATA')
  expect(response.headers.get('content-type')).toBe('application/octet-stream')
  expect(response.headers.get('x-amz-request-id')).toBeNull()
})

test('CACHE_TTL_SECONDS=0 always reads B2 and returns no-store', async () => {
  const cacheKey = new Request('https://cache.local/b2test/always-fresh')
  await caches.default.put(
    cacheKey,
    new Response('STALE', {
      headers: { 'cache-control': 'public, max-age=86400' },
    }),
  )

  let reads = 0
  fetchMock
    .get(ORIGIN)
    .intercept({ path: '/test-bucket/always-fresh', method: 'GET' })
    .reply(() => ({ statusCode: 200, data: `FRESH ${++reads}` }))
    .times(2)

  try {
    for (const expected of ['FRESH 1', 'FRESH 2']) {
      const ctx = createExecutionContext()
      const response = await worker.fetch(
        new Request('https://s.514996.xyz/always-fresh'),
        { ...env, CACHE_TTL_SECONDS: '0' },
        ctx,
      )
      await waitOnExecutionContext(ctx)

      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.text()).toBe(expected)
    }
    expect(reads).toBe(2)
  } finally {
    await caches.default.delete(cacheKey)
  }
})

test('maps /b paths to the same B2 key without rewriting the prefix', async () => {
  fetchMock
    .get(ORIGIN)
    .intercept({
      path: /\/test-bucket\/(?:image|b)\/pub123/,
      method: 'GET',
    })
    .reply(({ path }) => ({
      statusCode: 200,
      data: path.endsWith('/b/pub123') ? 'EXACT' : 'ALIASED',
    }))

  const ctx = createExecutionContext()
  const response = await worker.fetch(
    new Request('https://s.514996.xyz/b/pub123'),
    env,
    ctx,
  )
  await waitOnExecutionContext(ctx)

  expect(response.status).toBe(200)
  expect(await response.text()).toBe('EXACT')
})

test('uses the BUCKETS credential for direct reads', async () => {
  fetchMock
    .get(ORIGIN)
    .intercept({
      path: '/test-bucket/private-object',
      method: 'GET',
      headers: {
        authorization: /Credential=test-key-id\//,
      },
    })
    .reply(200, 'PRIVATE')

  const ctx = createExecutionContext()
  const response = await worker.fetch(
    new Request('https://s.514996.xyz/private-object'),
    env,
    ctx,
  )
  await waitOnExecutionContext(ctx)

  expect(response.status).toBe(200)
  expect(await response.text()).toBe('PRIVATE')
})

test('decodes URL path segments exactly once before reading B2', async () => {
  fetchMock
    .get(ORIGIN)
    .intercept({ path: '/test-bucket/folder/a%2520b.txt', method: 'GET' })
    .reply(200, 'SIGNED')

  const ctx = createExecutionContext()
  const response = await worker.fetch(
    new Request('https://s.514996.xyz/folder/a%2520b.txt'),
    env,
    ctx,
  )
  await waitOnExecutionContext(ctx)

  expect(response.status).toBe(200)
  expect(await response.text()).toBe('SIGNED')
})

test.each([
  ['/s/example', '/test-bucket/s/example'],
  ['/api/sign', '/test-bucket/api/sign'],
  ['/admin', '/test-bucket/admin'],
  ['/%73/encoded', '/test-bucket/s/encoded'],
  [
    '/chapter-content/v1/a.parquet',
    '/test-bucket/chapter-content/v1/a.parquet',
  ],
  ['/book-export/v1/a.7z', '/test-bucket/book-export/v1/a.7z'],
])('maps %s as an ordinary B2 key', async (path, originPath) => {
  fetchMock
    .get(ORIGIN)
    .intercept({ path: originPath, method: 'GET' })
    .reply(200, 'MAPPED')

  const ctx = createExecutionContext()
  const response = await worker.fetch(
    new Request(`https://s.514996.xyz${path}`),
    env,
    ctx,
  )
  await waitOnExecutionContext(ctx)

  expect(response.status).toBe(200)
  expect(await response.text()).toBe('MAPPED')
})
