import { env } from 'cloudflare:test'
import { expect, test, beforeEach } from 'vitest'
import { cleanupExpired } from '../index.js'
import { resetDb, insertLink, FUTURE, PAST } from './helpers.js'

beforeEach(resetDb)

test('cleanup removes only expired rows', async () => {
  await insertLink('keep00000001', 'b2test', 'a', FUTURE)
  await insertLink('gone00000001', 'b2test', 'b', PAST)
  await cleanupExpired(env)
  const { c } = await env.DB.prepare('SELECT count(*) c FROM links').first()
  expect(c).toBe(1)
  const kept = await env.DB.prepare('SELECT id FROM links').first()
  expect(kept.id).toBe('keep00000001')
})
