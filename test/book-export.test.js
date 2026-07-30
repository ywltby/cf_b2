import {
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
  beforeEach,
  afterEach,
  describe,
} from 'vitest'
import { resetDb, insertLink, FUTURE } from './helpers.js'

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
beforeEach(resetDb)
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

  test('short links use the dedicated book-export credentials', async () => {
    const key = 'book-export/v1/channel=fanqie/book.txt.7z'
    await insertLink('bookexport01', 'b2test', key, FUTURE)
    fetchMock
      .get(ORIGIN)
      .intercept({
        path: `/test-bucket/${key.replaceAll('=', '%3D')}`,
        method: 'GET',
        headers: {
          authorization: /Credential=book-export-key-id\//,
        },
      })
      .reply(200, '7Z')

    const res = await fetchBookExport('/s/bookexport01')

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('7Z')
  })
})
