import { SELF } from 'cloudflare:test'
import { expect, test, beforeEach } from 'vitest'
import { resetDb } from './helpers.js'

beforeEach(resetDb)

test('unknown path is forbidden and not cacheable', async () => {
  const res = await SELF.fetch('https://cdn.example.com/whatever')
  expect(res.status).toBe(403)
  expect(res.headers.get('cache-control')).toBe('no-store')
})
