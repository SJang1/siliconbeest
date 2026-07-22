import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './server/worker/index.ts',
      miniflare: {
        compatibilityDate: '2026-06-16',
        compatibilityFlags: ['nodejs_compat'],
        d1Databases: ['DB_META_C000'],
        r2Buckets: ['MEDIA_BUCKET'],
        kvNamespaces: ['CACHE', 'SESSIONS', 'FEDIFY_KV'],
        durableObjects: {
          STREAMING_DO: 'StreamingDO',
          STREAM_FANOUT_DO: { className: 'StreamFanoutDO', useSQLite: true },
          REALTIME_FEED_DO: { className: 'RealtimeFeedIndexDO', useSQLite: true },
          WRITE_JOURNAL_DO: { className: 'WriteJournalDO', useSQLite: true },
          IDENTITY_RESERVATION_DO: { className: 'IdentityReservationDO', useSQLite: true },
          INVITATION_LEDGER_DO: { className: 'InvitationLedgerDO', useSQLite: true },
          REGISTRATION_JOURNAL_DO: { className: 'RegistrationJournalDO', useSQLite: true },
          REMOTE_OBJECT_JOURNAL_DO: { className: 'RemoteObjectJournalDO', useSQLite: true },
        },
        queueProducers: {
          QUEUE_INBOX_0: { queueName: 'siliconbeest-inbox-0' },
          QUEUE_INBOX_1: { queueName: 'siliconbeest-inbox-1' },
          QUEUE_INBOX_2: { queueName: 'siliconbeest-inbox-2' },
          QUEUE_INBOX_3: { queueName: 'siliconbeest-inbox-3' },
          QUEUE_INBOX_4: { queueName: 'siliconbeest-inbox-4' },
          QUEUE_INBOX_5: { queueName: 'siliconbeest-inbox-5' },
          QUEUE_INBOX_6: { queueName: 'siliconbeest-inbox-6' },
          QUEUE_INBOX_7: { queueName: 'siliconbeest-inbox-7' },
          QUEUE_FEDERATION: { queueName: 'siliconbeest-federation' },
          QUEUE_INTERNAL: { queueName: 'siliconbeest-internal' },
          QUEUE_EMAIL: { queueName: 'siliconbeest-email' },
          QUEUE_DB_INSERT: { queueName: 'siliconbeest-db-insert' },
          QUEUE_DB_UPDATE: { queueName: 'siliconbeest-db-update' },
          QUEUE_REGISTRATION: { queueName: 'siliconbeest-registration' },
        },
        bindings: {
          INSTANCE_DOMAIN: 'test.siliconbeest.local',
          INSTANCE_TITLE: 'SiliconBeest Test',
          REGISTRATION_MODE: 'open',
          OTP_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          SETUP_SECRET: 'test-setup-secret',
          ASYNC_STATUS_WRITES: 'false',
          ASYNC_REGISTRATION_WRITES: 'false',
          SEARCH_FEED_READS: 'false',
          STREAM_PUBLIC_BRANCH_FACTOR: '5',
          STREAM_PUBLIC_TREE_DEPTH: '3',
          STREAM_PUBLIC_LEAF_MAX_SOCKETS: '400',
          STREAM_USER_MAX_SOCKETS: '32',
          STREAM_SOCKET_MAX_BUFFERED_BYTES: '262144',
          STREAM_EVENT_MAX_BYTES: '98304',
        },
      },
    }),
  ],
  test: {
    globals: true,
    include: ['test/worker/**/*.test.ts'],
  },
});
