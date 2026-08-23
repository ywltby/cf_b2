import { SELF } from 'cloudflare:test'
import { expect, test, beforeEach, describe } from 'vitest'
import { resetDb } from './helpers.js'

beforeEach(resetDb)

describe('reserved routes keep their existing behavior', () => {
  const cases = [
    ['GET', 'https://cdn.example.com/s/', 404],
    ['POST', 'https://cdn.example.com/s/abc123', 405],
    ['GET', 'https://cdn.example.com/s/doesnotexist', 404],
  ]
  for (const [method, url, status] of cases) {
    test(`${method} ${url} -> ${status}`, async () => {
      const res = await SELF.fetch(url, { method })
      expect(res.status).toBe(status)
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(await res.text()).toBe('')
    })
  }
})
