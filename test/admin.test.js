import { SELF } from 'cloudflare:test'
import { expect, test, beforeEach } from 'vitest'
import { resetDb } from './helpers.js'

beforeEach(resetDb)

test('GET /admin serves the signing HTML page', async () => {
  const res = await SELF.fetch('https://cdn.example.com/admin')
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toMatch(/text\/html/)
  const body = await res.text()
  expect(body).toContain('短链签发')
  expect(body).toContain('/api/sign')
  expect(body).toContain('id="permanent"')
  // page must not embed any secret or backend identifier
  expect(body).not.toContain('applicationKey')
  expect(body).not.toContain('backblazeb2.com')
})

test('POST /admin -> 405', async () => {
  const res = await SELF.fetch('https://cdn.example.com/admin', {
    method: 'POST',
  })
  expect(res.status).toBe(405)
})
