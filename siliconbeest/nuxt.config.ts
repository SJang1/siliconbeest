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
        const chunkPath = join(chunkDir, 'streaming-do.mjs');
        const entryPath = join(serverDir, 'index.mjs');

        await mkdir(chunkDir, { recursive: true });
        const streamingDoSource = await readFile(STREAMING_DO_SOURCE, 'utf8');
        const transformedStreamingDo = await transformWithEsbuild(
          streamingDoSource,
          STREAMING_DO_SOURCE,
          {
            loader: 'ts',
            format: 'esm',
            target: 'es2022',
          },
        );
        await writeFile(chunkPath, transformedStreamingDo.code);

        const entry = await readFile(entryPath, 'utf-8');
        const actorExport = [
          'import { StreamingDO as StreamingDOBase } from "./chunks/_/streaming-do.mjs";',
          'export class StreamingDO extends StreamingDOBase {}',
        ].join('\n');
        if (!entry.includes('export class StreamingDO')) {
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
