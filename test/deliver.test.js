import {
  SELF,
  env,
  fetchMock,
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
import { resetDb, insertLink, FUTURE } from './helpers.js'

const ORIGIN = 'https://s3.us-west-004.backblazeb2.com'

beforeAll(() => {
  fetchMock.activate()
  fetchMock.disableNetConnect()
})
beforeEach(resetDb)
afterEach(() => fetchMock.assertNoPendingInterceptors())

describe('GET /s/<id> happy path', () => {
  test('streams file, sanitizes headers, sets public cache-control', async () => {
    await insertLink('id0000000001', 'b2test', 'a.png', FUTURE)
    fetchMock
      .get(ORIGIN)
      .intercept({ path: '/test-bucket/a.png', method: 'GET' })
      .reply(200, 'PNGDATA', {
        headers: {
          'content-type': 'image/png',
          'content-length': '7',
          'accept-ranges': 'bytes',
          etag: '"abc"',
          'x-amz-request-id': 'LEAK',
          'x-amz-id-2': 'LEAK2',
        },
      })
    const res = await SELF.fetch('https://cdn.example.com/s/id0000000001')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('PNGDATA')
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('cache-control')).toBe('public, max-age=86400')
    expect(res.headers.get('x-amz-request-id')).toBeNull()
    expect(res.headers.get('x-amz-id-2')).toBeNull()
  })

  test('keys with special chars are RFC3986-encoded into the origin URL', async () => {
    await insertLink('id0000000004', 'b2test', 'a dir/b?c#d.png', FUTURE)
    // 若 aws4fetch 对 S3 路径双重编码，这里的 path 不匹配 -> fetchMock 抛错 -> 测试失败（正是我们要的暴露）
    fetchMock
      .get(ORIGIN)
      .intercept({ path: '/test-bucket/a%20dir/b%3Fc%23d.png', method: 'GET' })
      .reply(200, 'OK', {})
    const res = await SELF.fetch('https://cdn.example.com/s/id0000000004')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('OK')
  })

  test('endpoint scheme+port honored (MinIO-style; guards against host-only regression)', async () => {
    const BUCKETS = JSON.stringify([
      {
        id: 'minio',
        name: 'mybucket',
        endpoint: 'https://minio.example.com:9000',
        region: 'us-east-1',
        keyId: 'k',
        applicationKey: 's',
      },
    ])
    await insertLink('minio0000001', 'minio', 'a.png', FUTURE)
    fetchMock
      .get('https://minio.example.com:9000')
      .intercept({ path: '/mybucket/a.png', method: 'GET' })
      .reply(200, 'OK', {})
    const ctx = createExecutionContext()
    const res = await worker.fetch(
      new Request('https://cdn.example.com/s/minio0000001'),
      { ...env, BUCKETS },
      ctx,
    )
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(200) // 端口被保留进 origin URL
  })

  test('http endpoint is honored (trusted-network S3, e.g. local MinIO)', async () => {
    const BUCKETS = JSON.stringify([
      {
        id: 'http1',
        name: 'b',
        endpoint: 'http://minio.local:9000',
        region: 'us-east-1',
        keyId: 'k',
        applicationKey: 's',
      },
    ])
    await insertLink('http00000001', 'http1', 'a.png', FUTURE)
    fetchMock
      .get('http://minio.local:9000')
      .intercept({ path: '/b/a.png', method: 'GET' })
      .reply(200, 'OK', {})
    const ctx = createExecutionContext()
    const res = await worker.fetch(
      new Request('https://cdn.example.com/s/http00000001'),
      { ...env, BUCKETS },
      ctx,
    )
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(200) // http 端点（任意端口）走同一回源路径，防止误删 http 支持
  })

  test('two ids for same bucket+key hit one internal cache key', async () => {
    await insertLink('id0000000002', 'b2test', 'shared.bin', FUTURE)
    await insertLink('id0000000003', 'b2test', 'shared.bin', FUTURE)
    fetchMock
      .get(ORIGIN)
      .intercept({ path: '/test-bucket/shared.bin', method: 'GET' })
      .reply(200, 'SHARED', {
        headers: { 'content-type': 'application/octet-stream' },
      })
      .times(1)

    const ctx1 = createExecutionContext()
    const r1 = await worker.fetch(
      new Request('https://cdn.example.com/s/id0000000002'),
      env,
      ctx1,
    )
    expect(await r1.text()).toBe('SHARED')
    await waitOnExecutionContext(ctx1)

    const ctx2 = createExecutionContext()
    const r2 = await worker.fetch(
      new Request('https://cdn.example.com/s/id0000000003'),
      env,
      ctx2,
    )
    expect(await r2.text()).toBe('SHARED')
    await waitOnExecutionContext(ctx2)
    // assertNoPendingInterceptors in afterEach confirms exactly one upstream call
  })
})
