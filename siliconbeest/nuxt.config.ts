import { execSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import { transformWithEsbuild } from 'vite';
import { SILICONBEEST_BASE_VERSION } from './server/worker/version';

const INSTANCE_TITLE = process.env.INSTANCE_TITLE;
const STREAMING_DO_SOURCE = fileURLToPath(
  new URL('./server/worker/durableObjects/streaming.ts', import.meta.url),
);
const STREAM_FANOUT_DO_SOURCE = fileURLToPath(
  new URL('./server/worker/durableObjects/streamFanout.ts', import.meta.url),
);
const REALTIME_FEED_DO_SOURCE = fileURLToPath(
  new URL('./server/worker/durableObjects/realtimeFeedIndex.ts', import.meta.url),
);
const WRITE_JOURNAL_DO_SOURCE = fileURLToPath(
  new URL('./server/worker/durableObjects/writeJournal.ts', import.meta.url),
);
const IDENTITY_RESERVATION_DO_SOURCE = fileURLToPath(
  new URL('./server/worker/durableObjects/identityReservation.ts', import.meta.url),
);
const INVITATION_LEDGER_DO_SOURCE = fileURLToPath(
  new URL('./server/worker/durableObjects/invitationLedger.ts', import.meta.url),
);
const REGISTRATION_JOURNAL_DO_SOURCE = fileURLToPath(
  new URL('./server/worker/durableObjects/registrationJournal.ts', import.meta.url),
);
const REMOTE_OBJECT_JOURNAL_DO_SOURCE = fileURLToPath(
  new URL('./server/worker/durableObjects/remoteObjectJournal.ts', import.meta.url),
);
const CLOUDFLARE_ENTRY = fileURLToPath(new URL('./server/cloudflare-entry.ts', import.meta.url));

function getGitHash(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

function getAppVersion(): string {
  const hash = getGitHash();
  return hash ? `${SILICONBEEST_BASE_VERSION}+${hash}` : SILICONBEEST_BASE_VERSION;
}

export default defineNuxtConfig({
  compatibilityDate: '2026-06-16',
  ssr: true,
  devtools: { enabled: false },
  css: ['@/assets/main.css', '@/assets/deck.css'],
  alias: {
    '@': fileURLToPath(new URL('./src', import.meta.url)),
  },
  app: {
    head: {
      htmlAttrs: { lang: 'en' },
      charset: 'utf-8',
      viewport: 'width=device-width, initial-scale=1.0, viewport-fit=cover',
      title: INSTANCE_TITLE,
      meta: [
        { name: 'theme-color', content: '#6366f1' },
        { name: 'apple-mobile-web-app-capable', content: 'yes' },
        { name: 'apple-mobile-web-app-status-bar-style', content: 'default' },
        { name: 'apple-mobile-web-app-title', content: INSTANCE_TITLE },
        { name: 'mobile-web-app-capable', content: 'yes' },
      ],
      link: [
        { rel: 'icon', href: '/favicon.ico' },
        { rel: 'manifest', href: '/manifest.json' },
        { rel: 'apple-touch-icon', href: '/pwa-icon/192.png' },
      ],
      script: [
        {
          src: '/theme-init.js',
          tagPosition: 'head',
        },
      ],
    },
  },
  runtimeConfig: {
    public: {
      sentryDsn: process.env.NUXT_PUBLIC_SENTRY_DSN || process.env.VITE_SENTRY_DSN || '',
      // 'true' enables the Sentry user-feedback widget (requires sentryDsn; off by default)
      sentryFeedback: process.env.NUXT_PUBLIC_SENTRY_FEEDBACK || process.env.VITE_SENTRY_FEEDBACK || '',
      appVersion: getAppVersion(),
      instanceTitle: INSTANCE_TITLE,
    },
  },
  nitro: {
    preset: 'cloudflare_module',
    entry: CLOUDFLARE_ENTRY,
    prerender: {
      autoSubfolderIndex: false,
    },
    hooks: {
      async compiled(nitro) {
        const serverDir = nitro.options.output.serverDir;
        const chunkDir = join(serverDir, 'chunks', '_');
        const entryPath = join(serverDir, 'index.mjs');

        await mkdir(chunkDir, { recursive: true });
        const actors = [
          { source: STREAMING_DO_SOURCE, chunk: 'streaming-do.mjs' },
          { source: STREAM_FANOUT_DO_SOURCE, chunk: 'stream-fanout-do.mjs' },
          { source: REALTIME_FEED_DO_SOURCE, chunk: 'realtime-feed-do.mjs' },
          { source: WRITE_JOURNAL_DO_SOURCE, chunk: 'write-journal-do.mjs' },
          { source: IDENTITY_RESERVATION_DO_SOURCE, chunk: 'identity-reservation-do.mjs' },
          { source: INVITATION_LEDGER_DO_SOURCE, chunk: 'invitation-ledger-do.mjs' },
          { source: REGISTRATION_JOURNAL_DO_SOURCE, chunk: 'registration-journal-do.mjs' },
          { source: REMOTE_OBJECT_JOURNAL_DO_SOURCE, chunk: 'remote-object-journal-do.mjs' },
        ];
        for (const actor of actors) {
          const source = await readFile(actor.source, 'utf8');
          const transformed = await transformWithEsbuild(source, actor.source, {
            loader: 'ts',
            format: 'esm',
            target: 'es2022',
          });
          await writeFile(join(chunkDir, actor.chunk), transformed.code);
        }

        const entry = await readFile(entryPath, 'utf-8');
        const actorExport = [
          'import { StreamingDO as StreamingDOBase } from "./chunks/_/streaming-do.mjs";',
          'export class StreamingDO extends StreamingDOBase {}',
          'import { StreamFanoutDO as StreamFanoutDOBase } from "./chunks/_/stream-fanout-do.mjs";',
          'export class StreamFanoutDO extends StreamFanoutDOBase {}',
          'import { RealtimeFeedIndexDO as RealtimeFeedIndexDOBase } from "./chunks/_/realtime-feed-do.mjs";',
          'export class RealtimeFeedIndexDO extends RealtimeFeedIndexDOBase {}',
          'import { WriteJournalDO as WriteJournalDOBase } from "./chunks/_/write-journal-do.mjs";',
          'export class WriteJournalDO extends WriteJournalDOBase {}',
          'import { IdentityReservationDO as IdentityReservationDOBase } from "./chunks/_/identity-reservation-do.mjs";',
          'export class IdentityReservationDO extends IdentityReservationDOBase {}',
          'import { InvitationLedgerDO as InvitationLedgerDOBase } from "./chunks/_/invitation-ledger-do.mjs";',
          'export class InvitationLedgerDO extends InvitationLedgerDOBase {}',
          'import { RegistrationJournalDO as RegistrationJournalDOBase } from "./chunks/_/registration-journal-do.mjs";',
          'export class RegistrationJournalDO extends RegistrationJournalDOBase {}',
          'import { RemoteObjectJournalDO as RemoteObjectJournalDOBase } from "./chunks/_/remote-object-journal-do.mjs";',
          'export class RemoteObjectJournalDO extends RemoteObjectJournalDOBase {}',
        ].join('\n');
        if (!entry.includes('export class WriteJournalDO')) {
          await writeFile(entryPath, `${entry}\n${actorExport}\n`);
        }
      },
    },
  },
  vite: {
    define: {
      __GIT_HASH__: JSON.stringify(getGitHash()),
      __APP_VERSION__: JSON.stringify(getAppVersion()),
    },
    plugins: [tailwindcss()],
  },
  typescript: {
    typeCheck: true,
  },
});
