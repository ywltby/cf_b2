import {
  env,
  fetchMock,
  createExecutionContext,
  waitOnExecutionContext,
} from 'cloudflare:test'
import worker from '../index.js'
import { afterEach, beforeAll, expect, test } from 'vitest'

const ORIGIN = 'https://s3.us-west-004.backblazeb2.com'

beforeAll(() => {
  fetchMock.activate()
  fetchMock.disableNetConnect()
})

afterEach(() => fetchMock.assertNoPendingInterceptors())

test('serves the existing 100 MiB speed test at the root path', async () => {
  const response = await worker.fetch(
    new Request('https://s.514996.xyz/'),
    env,
    createExecutionContext(),
  )

  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
  expect(response.headers.get('cache-control')).toBe('no-store')

  const html = await response.text()
  expect(html).toContain("const TEST_URL = '/BLM-008.mp4'")
  expect(html).toContain('104857600')
  expect(html).toContain('Range')
  expect(response.headers.get('content-security-policy')).toContain(
    "connect-src 'self'",
  )
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
        authorization: /Credential=direct-test-key-id\//,
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

test('fails closed when direct-read credentials are missing', async () => {
  const response = await worker.fetch(
    new Request('https://s.514996.xyz/private-object'),
    {
      ...env,
      DIRECT_B2_KEY_ID: undefined,
      DIRECT_B2_APPLICATION_KEY: undefined,
    },
    createExecutionContext(),
  )

  expect(response.status).toBe(500)
  expect(response.headers.get('cache-control')).toBe('no-store')
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

test('does not let encoded paths bypass a reserved route', async () => {
  const response = await worker.fetch(
    new Request('https://s.514996.xyz/book-%65xport/v1/bypass.7z'),
    env,
    createExecutionContext(),
  )

  expect(response.status).toBe(404)
  expect(response.headers.get('cache-control')).toBe('no-store')
})
