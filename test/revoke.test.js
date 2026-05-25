import { SELF } from 'cloudflare:test'
import { expect, test, beforeEach } from 'vitest'
import { resetDb, insertLink, FUTURE } from './helpers.js'

beforeEach(resetDb)
const AUTH = {
  'content-type': 'application/json',
  authorization: 'Bearer test-admin-pass',
}

test('revoke deletes the link; subsequent access 404', async () => {
  await insertLink('rev000000001', 'b2test', 'a.png', FUTURE)
  const del = await SELF.fetch('https://cdn.example.com/api/revoke', {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({ id: 'rev000000001' }),
  })
  expect(del.status).toBe(200)
  expect(await del.json()).toEqual({ deleted: true })
  const res = await SELF.fetch('https://cdn.example.com/s/rev000000001')
  expect(res.status).toBe(404)
})

test('revoke of unknown id -> deleted:false', async () => {
  const del = await SELF.fetch('https://cdn.example.com/api/revoke', {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({ id: 'nope' }),
  })
  expect(del.status).toBe(200)
  expect(await del.json()).toEqual({ deleted: false })
})

test('revoke without auth -> 401', async () => {
  const res = await SELF.fetch('https://cdn.example.com/api/revoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"id":"x"}',
  })
  expect(res.status).toBe(401)
})

test('GET /api/revoke -> 405', async () => {
  const res = await SELF.fetch('https://cdn.example.com/api/revoke')
  expect(res.status).toBe(405)
})
