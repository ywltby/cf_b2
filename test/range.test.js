import { SELF, fetchMock } from 'cloudflare:test'
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

describe('Range', () => {
  test('passes Range, returns 206, not cached (each request hits origin)', async () => {
    await insertLink('vid000000001', 'b2test', 'movie.mp4', FUTURE)
    await insertLink('vid000000002', 'b2test', 'movie.mp4', FUTURE)
    fetchMock
      .get(ORIGIN)
      .intercept({ path: '/test-bucket/movie.mp4', method: 'GET' })
      .reply(206, 'PARTIA', {
        headers: {
          'content-range': 'bytes 0-5/100',
          'content-length': '6',
          'accept-ranges': 'bytes',
          'content-type': 'video/mp4',
        },
      })
      .times(2)
    const opts = { headers: { range: 'bytes=0-5' } }
    const r1 = await SELF.fetch('https://cdn.example.com/s/vid000000001', opts)
    expect(r1.status).toBe(206)
    expect(r1.headers.get('content-range')).toBe('bytes 0-5/100')
    expect(r1.headers.get('content-disposition')).toBe(
      `attachment; filename="movie.mp4"; filename*=UTF-8''movie.mp4`,
    )
    expect(await r1.text()).toBe('PARTIA')
    const r2 = await SELF.fetch('https://cdn.example.com/s/vid000000002', opts)
    expect(r2.status).toBe(206)
  })

  test('retries when large-file response lacks content-range, then succeeds', async () => {
    await insertLink('big000000001', 'b2test', 'big.iso', FUTURE)
    const pool = fetchMock.get(ORIGIN)
    pool
      .intercept({ path: '/test-bucket/big.iso', method: 'GET' })
      .reply(200, 'FULL', { headers: { 'content-length': '4' } })
      .times(2)
    pool
      .intercept({ path: '/test-bucket/big.iso', method: 'GET' })
      .reply(206, 'CHUN', {
        headers: { 'content-range': 'bytes 0-3/9999', 'content-length': '4' },
      })
    const res = await SELF.fetch('https://cdn.example.com/s/big000000001', {
      headers: { range: 'bytes=0-3' },
    })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 0-3/9999')
  })

  test('3 attempts all non-206 -> 502, no body (never return full file to a Range)', async () => {
    await insertLink('bad000000001', 'b2test', 'big.iso', FUTURE)
    fetchMock
      .get(ORIGIN)
      .intercept({ path: '/test-bucket/big.iso', method: 'GET' })
      .reply(200, 'WHOLEFILE', { headers: { 'content-length': '9' } })
      .times(3)
    const res = await SELF.fetch('https://cdn.example.com/s/bad000000001', {
      headers: { range: 'bytes=0-3' },
    })
    expect(res.status).toBe(502)
    expect(await res.text()).toBe('')
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  test('416 from upstream -> 416', async () => {
    await insertLink('r16000000001', 'b2test', 'x.bin', FUTURE)
    fetchMock
      .get(ORIGIN)
      .intercept({ path: '/test-bucket/x.bin', method: 'GET' })
      .reply(416, '', {})
    const res = await SELF.fetch('https://cdn.example.com/s/r16000000001', {
      headers: { range: 'bytes=99999-' },
    })
    expect(res.status).toBe(416)
  })
})
