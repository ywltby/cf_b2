import {
  env,
  fetchMock,
  createExecutionContext,
  waitOnExecutionContext,
} from 'cloudflare:test'
import worker from '../index.js'
import { expect, test, beforeAll, afterEach, describe } from 'vitest'

const ORIGIN = 'https://s3.us-west-004.backblazeb2.com'
const CHAPTER_ENV = { ...env, CHAPTER_CONTENT_BUCKET_ID: 'b2test' }

beforeAll(() => {
  fetchMock.activate()
  fetchMock.disableNetConnect()
})
afterEach(() => fetchMock.assertNoPendingInterceptors())

async function fetchChapter(path, init = {}, testEnv = CHAPTER_ENV) {
  const ctx = createExecutionContext()
  const res = await worker.fetch(
    new Request(`https://cdn.example.com${path}`, init),
    testEnv,
    ctx,
  )
  await waitOnExecutionContext(ctx)
  return res
}

describe('GET|HEAD /chapter-content/<key>', () => {
  test('streams the exact chapter-content object key', async () => {
    const key =
      'chapter-content/v1/channel=fanqie/book=ab/book-id/segments/base/segment-deadbeef.parquet'
    fetchMock
      .get(ORIGIN)
      .intercept({
        path: `/test-bucket/${key.replaceAll('=', '%3D')}`,
        method: 'GET',
      })
      .reply(200, 'PARQUET', {
        headers: {
          'content-type': 'application/vnd.apache.parquet',
          'x-bz-info-segment_sha256': 'secret-metadata',
        },
      })

    const res = await fetchChapter(`/${key}`)

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('PARQUET')
    expect(res.headers.get('content-type')).toBe(
      'application/vnd.apache.parquet',
    )
    expect(res.headers.get('x-bz-info-segment_sha256')).toBeNull()
  })

  test('rejects non GET/HEAD methods', async () => {
    const res = await fetchChapter('/chapter-content/v1/a.parquet', {
      method: 'POST',
    })

    expect(res.status).toBe(405)
  })

  test('fails closed when the chapter bucket is not configured', async () => {
    const res = await fetchChapter(
      '/chapter-content/v1/a.parquet',
      {},
      { ...env, CHAPTER_CONTENT_BUCKET_ID: undefined },
    )

    expect(res.status).toBe(500)
  })
})
