import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            BUCKETS: JSON.stringify([
              {
                id: 'b2test',
                name: 'test-bucket',
                endpoint: 's3.us-west-004.backblazeb2.com',
                region: 'us-west-004',
                keyId: 'test-key-id',
                applicationKey: 'test-app-key',
              },
            ]),
            ADMIN_PASSWORD: 'test-admin-pass',
            DIRECT_B2_KEY_ID: 'direct-test-key-id',
            DIRECT_B2_APPLICATION_KEY: 'direct-test-app-key',
            CACHE_TTL_SECONDS: '86400',
            TOKEN_TTL_SECONDS: '3600',
            TOKEN_ID_LENGTH: '12',
            B_BUCKET_ID: 'b2test',
            B_PREFIX: 'image/',
          },
        },
      },
    },
  },
})
