import { createExecutionContext, env } from 'cloudflare:test'
import { expect, test } from 'vitest'
import shortlink from '../src/shortlink.js'

for (const path of ['/', '/object.bin', '/b/x', '/chapter-content/x']) {
  test(`shortlink rejects mapper path ${path}`, async () => {
    const response = await shortlink.fetch(
      new Request(`https://shortlink.example.com${path}`),
      env,
      createExecutionContext(),
    )

    expect(response.status).toBe(404)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).toBe('')
  })
}
