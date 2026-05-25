import { env } from 'cloudflare:test'

export async function resetDb() {
  await env.DB.prepare('DROP TABLE IF EXISTS links').run()
  await env.DB.prepare(
    'CREATE TABLE links (id TEXT PRIMARY KEY, bucket_id TEXT NOT NULL, p TEXT NOT NULL, exp INTEGER NOT NULL)',
  ).run()
}

// key 传规范化后的对象 key（无前导斜杠）
export async function insertLink(id, bucketId, key, exp) {
  await env.DB.prepare(
    'INSERT INTO links (id, bucket_id, p, exp) VALUES (?, ?, ?, ?)',
  )
    .bind(id, bucketId, key, exp)
    .run()
}

export const FUTURE = Math.floor(Date.now() / 1000) + 3600
export const PAST = Math.floor(Date.now() / 1000) - 10
