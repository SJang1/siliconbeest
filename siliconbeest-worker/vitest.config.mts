import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: './wrangler.jsonc',
      },
      miniflare: {
        bindings: {
          INSTANCE_DOMAIN: 'test.siliconbeest.local',
          INSTANCE_TITLE: 'SiliconBeest Test',
          REGISTRATION_MODE: 'open',
          VAPID_PUBLIC_KEY: 'BDd3_hVL9fZi9Ybo2UUzA284WG5FZR30_95YeZJsiApwXKpNcF1rRPF3foIiBHXRdJI2Gkf39',
          VAPID_PRIVATE_KEY: 'dGVzdC12YXBpZC1wcml2YXRlLWtleQ',
          OTP_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        },
      },
    }),
  ],
  test: {
    globals: true,
  },
});
