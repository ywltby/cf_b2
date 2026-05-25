import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
const forbidden = [
  /\.arrayBuffer\s*\(/, // never needed
  /\.blob\s*\(/, // never needed
  /(?<!request)\.text\s*\(/, // upstream body read (request.* admin body is allowed)
  /(?<!request)\.json\s*\(/,
]
const hits = forbidden.filter((re) => re.test(src))
if (hits.length) {
  console.error('Streaming guard FAILED: index.js must not buffer upstream bodies:', hits.map(String))
  process.exit(1)
}
if (!/new Response\(\s*resp\.body/.test(src)) {
  console.warn('Streaming guard WARN: streaming pattern new Response(resp.body, ...) not found')
}
console.log('Streaming guard passed')
