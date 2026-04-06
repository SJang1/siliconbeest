import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './server/worker/index.ts',
      miniflare: {
        compatibilityDate: '2024-12-18',
        compatibilityFlags: ['nodejs_compat'],
        d1Databases: ['DB'],
        r2Buckets: ['MEDIA_BUCKET'],
        kvNamespaces: ['CACHE', 'SESSIONS', 'FEDIFY_KV'],
        queueProducers: {
          QUEUE_FEDERATION: { queueName: 'siliconbeest-federation' },
          QUEUE_INTERNAL: { queueName: 'siliconbeest-internal' },
          QUEUE_EMAIL: { queueName: 'siliconbeest-email' },
        },
        bindings: {
          INSTANCE_DOMAIN: 'test.siliconbeest.local',
          INSTANCE_TITLE: 'SiliconBeest Test',
          REGISTRATION_MODE: 'open',
          OTP_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        },
      },
    }),
  ],
  test: {
    globals: true,
    include: ['test/worker/**/*.test.ts'],
  },
});
