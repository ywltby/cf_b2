import { readFileSync } from 'node:fs'

const raw = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
// Ignore template-literal contents (e.g. the embedded admin HTML, whose client-side
// JS legitimately calls r.text()/r.json()). The worker's own upstream-body reads are
// never inside template literals.
const src = raw.replace(/`[\s\S]*?`/g, '``')
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
