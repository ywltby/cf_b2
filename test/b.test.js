import {
  env,
  fetchMock,
  createExecutionContext,
  waitOnExecutionContext,
} from 'cloudflare:test'
import worker from '../index.js'
import { expect, test, beforeAll, afterEach, describe } from 'vitest'

const ORIGIN = 'https://s3.us-west-004.backblazeb2.com'
const B_ENV = { ...env, B_BUCKET_ID: 'b2test', B_PREFIX: 'image/' }

beforeAll(() => {
  fetchMock.activate()
  fetchMock.disableNetConnect()
})
afterEach(() => fetchMock.assertNoPendingInterceptors())

async function fetchB(path, init = {}, testEnv = B_ENV) {
  const ctx = createExecutionContext()
  const res = await worker.fetch(
    new Request(`https://cdn.example.com${path}`, init),
    testEnv,
    ctx,
  )
  await waitOnExecutionContext(ctx)
  return res
}

describe('GET|HEAD /b/<key>', () => {
  test('streams public image from configured bucket and prefix', async () => {
    fetchMock
      .get(ORIGIN)
      .intercept({ path: '/test-bucket/image/pub123', method: 'GET' })
      .reply(200, 'IMGDATA', {
        headers: {
          'content-type': 'image/webp',
          'content-length': '7',
          'x-amz-request-id': 'LEAK',
        },
      })

    const res = await fetchB('/b/pub123')

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('IMGDATA')
    expect(res.headers.get('content-type')).toBe('image/webp')
    expect(res.headers.get('x-amz-request-id')).toBeNull()
  })

  test('passes Range and returns 206 without caching', async () => {
    fetchMock
      .get(ORIGIN)
      .intercept({ path: '/test-bucket/image/pub123', method: 'GET' })
      .reply(206, 'PART', {
        headers: {
          'content-type': 'image/jpeg',
          'content-range': 'bytes 0-3/7',
          'content-length': '4',
        },
      })
      .times(2)

    const init = { headers: { range: 'bytes=0-3' } }
    const first = await fetchB('/b/pub123', init)
    const second = await fetchB('/b/pub123', init)

    expect(first.status).toBe(206)
    expect(first.headers.get('content-range')).toBe('bytes 0-3/7')
    expect(await first.text()).toBe('PART')
    expect(second.status).toBe(206)
  })

  test('HEAD returns metadata headers and empty body', async () => {
    fetchMock
      .get(ORIGIN)
      .intercept({ path: '/test-bucket/image/pub123', method: 'GET' })
      .reply(200, 'IGNOREDBODY', {
        headers: {
          'content-type': 'image/png',
          'content-length': '12345',
        },
      })

    const res = await fetchB('/b/pub123', { method: 'HEAD' })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('content-length')).toBe('12345')
    expect(await res.text()).toBe('')
  })

  test('non GET/HEAD methods are rejected with 405', async () => {
    const res = await fetchB('/b/pub123', { method: 'POST' })

    expect(res.status).toBe(405)
    expect(await res.text()).toBe('')
  })

  test('invalid key is rejected without origin fetch', async () => {
    const res = await fetchB('/b/a//b')
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('')
  })

  test('literal encoded dot-dot inside a segment remains inside configured prefix', async () => {
    fetchMock
      .get(ORIGIN)
      .intercept({ path: '/test-bucket/image/a%252e%252eb', method: 'GET' })
      .reply(200, 'OK', {})

    const res = await fetchB('/b/a%2e%2eb')

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('OK')
  })

  test('missing bucket config fails closed without origin fetch', async () => {
    const res = await fetchB(
      '/b/pub123',
      {},
      { ...env, B_BUCKET_ID: undefined },
    )

    expect(res.status).toBe(500)
    expect(await res.text()).toBe('')
  })

  test('missing prefix config fails closed without origin fetch', async () => {
    const res = await fetchB(
      '/b/pub123',
      {},
      { ...env, B_BUCKET_ID: 'b2test', B_PREFIX: undefined },
    )

    expect(res.status).toBe(500)
    expect(await res.text()).toBe('')
  })

  test('prefix traversal config fails closed without origin fetch', async () => {
    const res = await fetchB('/b/pub123', {}, { ...B_ENV, B_PREFIX: '../' })

    expect(res.status).toBe(500)
    expect(await res.text()).toBe('')
  })
})
