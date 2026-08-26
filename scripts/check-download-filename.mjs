import assert from 'node:assert/strict'

import { requestedDownloadFilename } from '../src/b2.js'

assert.equal(
  requestedDownloadFilename(
    new Request(
      'https://cdn.example.com/s/id?filename=%E6%B5%8B%E8%AF%95%E4%B9%A6.txt',
    ),
  ),
  '测试书.txt',
)
assert.equal(
  requestedDownloadFilename(
    new Request('https://cdn.example.com/s/id?filename=bad%2Fname.txt'),
  ),
  '',
)
