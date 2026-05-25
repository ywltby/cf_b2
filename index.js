export default {
  async fetch() {
    return new Response(null, { status: 403, headers: { 'cache-control': 'no-store' } })
  },
}
