import {
  fetchMock,
  createExecutionContext,
  waitOnExecutionContext,
} from 'cloudflare:test'
import { AwsClient } from 'aws4fetch'
import snippet from '../snippet-b2.js'
import { afterEach, beforeAll, expect, test } from 'vitest'

const B2_ORIGIN = 'https://s3.us-west-004.backblazeb2.com'

beforeAll(() => {
  fetchMock.activate()
  fetchMock.disableNetConnect()
})

afterEach(() => fetchMock.assertNoPendingInterceptors())

test('serves a fixed 100 MiB download speed test at the root path', async () => {
  const response = await snippet.fetch(new Request('https://b.o7n.cn/'))

  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')

  const html = await response.text()
  expect(html).toContain("const TEST_URL = '/BLM-008.mp4'")
  expect(html).not.toContain('b.wgoyai.kdns.fr')
  expect(html).toContain('104857600')
  expect(html).toContain('Range')
  expect(response.headers.get('content-security-policy')).toContain(
    "connect-src 'self'",
  )
})

test('maps nested URL paths directly to the same B2 object key', async () => {
  expect(snippet.fetch).toBeTypeOf('function')

  fetchMock
    .get(B2_ORIGIN)
    .intercept({
      path: '/replace-with-bucket/folder-a/folder-b/object-123',
      method: 'GET',
    })
    .reply(200, 'OBJECT DATA', {
      headers: {
        'content-type': 'application/octet-stream',
        'x-amz-request-id': 'must-not-leak',
      },
    })

  const ctx = createExecutionContext()
  const response = await snippet.fetch(
    new Request('https://files.example.com/folder-a/folder-b/object-123'),
    {},
    ctx,
  )
  await waitOnExecutionContext(ctx)

  expect(response.status).toBe(200)
  expect(await response.text()).toBe('OBJECT DATA')
  expect(response.headers.get('content-type')).toBe('application/octet-stream')
  expect(response.headers.get('x-amz-request-id')).toBeNull()
})

test('caches successful full GET responses by object key', async () => {
  fetchMock
    .get(B2_ORIGIN)
    .intercept({
      path: '/replace-with-bucket/folder/cached-object',
      method: 'GET',
    })
    .reply(200, 'CACHED DATA', {
      headers: { 'content-type': 'application/octet-stream' },
    })

  const request = new Request('https://files.example.com/folder/cached-object')
  const firstContext = createExecutionContext()
  const first = await snippet.fetch(request, {}, firstContext)
  await waitOnExecutionContext(firstContext)

  const secondContext = createExecutionContext()
  const second = await snippet.fetch(request, {}, secondContext)
  await waitOnExecutionContext(secondContext)

  expect(await first.text()).toBe('CACHED DATA')
  expect(await second.text()).toBe('CACHED DATA')
})

test('caches full GET responses without a Worker execution context', async () => {
  fetchMock
    .get(B2_ORIGIN)
    .intercept({
      path: '/replace-with-bucket/folder/snippet-cache',
      method: 'GET',
    })
    .reply(200, 'SNIPPET CACHE', {
      headers: { 'content-type': 'application/octet-stream' },
    })

  const response = await snippet.fetch(
    new Request('https://files.example.com/folder/snippet-cache'),
  )

  expect(response.status).toBe(200)
  expect(await response.text()).toBe('SNIPPET CACHE')
})

test('produces the same B2 SigV4 authorization as aws4fetch', async () => {
  let actualHeaders
  fetchMock
    .get(B2_ORIGIN)
    .intercept({
      path: '/replace-with-bucket/folder/a%20b.txt',
      method: 'GET',
    })
    .reply((options) => {
      actualHeaders = new Headers(options.headers)
      return { statusCode: 200, data: 'SIGNED' }
    })

  const response = await snippet.fetch(
    new Request('https://files.example.com/folder/a%20b.txt', {
      method: 'HEAD',
    }),
    {},
    createExecutionContext(),
  )
  expect(response.status).toBe(200)

  const datetime = actualHeaders.get('x-amz-date')
  const expected = await new AwsClient({
    accessKeyId: 'replace-with-read-only-key-id',
    secretAccessKey: 'replace-with-read-only-application-key',
    service: 's3',
    region: 'us-west-004',
  }).sign(`${B2_ORIGIN}/replace-with-bucket/folder/a%20b.txt`, {
    method: 'GET',
    aws: { datetime },
  })

  expect(actualHeaders.get('authorization')).toBe(
    expected.headers.get('authorization'),
  )
})

test('passes B2 errors through without retrying', async () => {
  fetchMock
    .get(B2_ORIGIN)
    .intercept({
      path: '/replace-with-bucket/folder/upstream-error',
      method: 'GET',
    })
    .reply(503, '<Error>busy</Error>', {
      headers: {
        'content-type': 'application/xml',
        'x-amz-request-id': 'request-id',
      },
    })

  const response = await snippet.fetch(
    new Request('https://files.example.com/folder/upstream-error'),
    {},
    createExecutionContext(),
  )

  expect(response.status).toBe(503)
  expect(response.headers.get('x-amz-request-id')).toBe('request-id')
  expect(await response.text()).toBe('<Error>busy</Error>')
})

test('rejects writes without contacting B2', async () => {
  const response = await snippet.fetch(
    new Request('https://files.example.com/folder/object-123', {
      method: 'PUT',
      body: 'data',
    }),
    {},
    createExecutionContext(),
  )

  expect(response.status).toBe(405)
})
