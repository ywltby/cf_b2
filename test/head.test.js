import { SELF, fetchMock } from 'cloudflare:test'
import { expect, test, beforeAll, afterEach, beforeEach } from 'vitest'
import { resetDb, insertLink, FUTURE } from './helpers.js'

const ORIGIN = 'https://s3.us-west-004.backblazeb2.com'

beforeAll(() => {
  fetchMock.activate()
  fetchMock.disableNetConnect()
})
beforeEach(resetDb)
afterEach(() => fetchMock.assertNoPendingInterceptors())

test('HEAD returns metadata headers and empty body', async () => {
  await insertLink('head00000001', 'b2test', 'clip.mp4', FUTURE)
  fetchMock
    .get(ORIGIN)
    .intercept({ path: '/test-bucket/clip.mp4', method: 'GET' })
    .reply(200, 'IGNOREDBODY', {
      headers: {
        'content-type': 'video/mp4',
        'content-length': '12345',
        'accept-ranges': 'bytes',
      },
    })
  const res = await SELF.fetch('https://cdn.example.com/s/head00000001', {
    method: 'HEAD',
  })
  expect(res.status).toBe(200)
  expect(res.headers.get('content-length')).toBe('12345')
  expect(res.headers.get('accept-ranges')).toBe('bytes')
  expect(await res.text()).toBe('')
})

test('HEAD + Range returns empty body 206', async () => {
  await insertLink('head00000002', 'b2test', 'clip.mp4', FUTURE)
  fetchMock
    .get(ORIGIN)
    .intercept({ path: '/test-bucket/clip.mp4', method: 'GET' })
    .reply(206, 'PART', {
      headers: { 'content-range': 'bytes 0-3/100', 'content-length': '4' },
    })
  const res = await SELF.fetch('https://cdn.example.com/s/head00000002', {
    method: 'HEAD',
    headers: { range: 'bytes=0-3' },
  })
  expect(res.status).toBe(206)
  expect(res.headers.get('content-range')).toBe('bytes 0-3/100')
  expect(await res.text()).toBe('')
})
