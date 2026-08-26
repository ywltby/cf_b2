import { decodePathKey, handlePublicBucket, noStore } from './b2.js'

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return noStore(405, 'Method Not Allowed')
    }

    const key = decodePathKey(new URL(request.url).pathname)
    return handlePublicBucket(request, env, ctx, key, env.B_BUCKET_ID)
  },
}
