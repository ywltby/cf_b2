import { readFileSync } from 'node:fs'

const files = [
  new URL('../src/b2.js', import.meta.url),
  new URL('../src/shortlink.js', import.meta.url),
  new URL('../src/mapper.js', import.meta.url),
]
const raw = files.map((file) => readFileSync(file, 'utf8')).join('\n')
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
  console.error(
    'Streaming guard FAILED: Worker code must not buffer upstream bodies:',
    hits.map(String),
  )
  process.exit(1)
}
if (!/new Response\(\s*resp\.body/.test(src)) {
  console.warn(
    'Streaming guard WARN: streaming pattern new Response(resp.body, ...) not found',
  )
}
if (/^\s*resp\.body\?\.cancel\(\)\s*$/m.test(src)) {
  console.error(
    'Streaming guard FAILED: response body cancellation must be awaited',
  )
  process.exit(1)
}
console.log('Streaming guard passed')
