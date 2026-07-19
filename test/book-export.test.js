import {
  env,
  fetchMock,
  createExecutionContext,
  waitOnExecutionContext,
} from 'cloudflare:test'
import worker from '../index.js'
import { expect, test, beforeAll, afterEach, describe } from 'vitest'

const ORIGIN = 'https://s3.us-west-004.backblazeb2.com'
const BOOK_EXPORT_ENV = {
  ...env,
  BOOK_EXPORT_BUCKET_ID: 'b2test',
  BOOK_EXPORT_KEY_ID: 'book-export-key-id',
  BOOK_EXPORT_APPLICATION_KEY: 'book-export-application-key',
}

beforeAll(() => {
  fetchMock.activate()
  fetchMock.disableNetConnect()
})
afterEach(() => fetchMock.assertNoPendingInterceptors())

async function fetchBookExport(path, init = {}, testEnv = BOOK_EXPORT_ENV) {
  const ctx = createExecutionContext()
  const res = await worker.fetch(
    new Request(`https://cdn.example.com${path}`, init),
    testEnv,
    ctx,
  )
  await waitOnExecutionContext(ctx)
  return res
}

describe('GET|HEAD /book-export/<key>', () => {
  test('streams the exact book-export object key', async () => {
    const key =
      'book-export/v1/channel=fanqie/book=ab/book-id/fingerprint/profile/txt/build=id/hash/book.txt.7z'
    fetchMock
      .get(ORIGIN)
      .intercept({
        path: `/test-bucket/${key.replaceAll('=', '%3D')}`,
        method: 'GET',
      })
      .reply(200, '7Z', {
        headers: { 'content-type': 'application/x-7z-compressed' },
      })

    const res = await fetchBookExport(`/${key}`)

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('7Z')
    expect(res.headers.get('content-type')).toBe('application/x-7z-compressed')
  })

  test('rejects non GET/HEAD methods', async () => {
    const res = await fetchBookExport('/book-export/v1/a.7z', {
      method: 'POST',
    })

    expect(res.status).toBe(405)
  })

  test('fails closed when dedicated read credentials are missing', async () => {
    const res = await fetchBookExport(
      '/book-export/v1/a.7z',
      {},
      {
        ...BOOK_EXPORT_ENV,
        BOOK_EXPORT_KEY_ID: undefined,
        BOOK_EXPORT_APPLICATION_KEY: undefined,
      },
    )

    expect(res.status).toBe(500)
  })
})
