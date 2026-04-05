import { fileURLToPath, URL } from 'node:url';
import { execSync } from 'node:child_process';

import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import vueDevTools from 'vite-plugin-vue-devtools';
import tailwindcss from '@tailwindcss/vite';
import { cloudflare } from '@cloudflare/vite-plugin';

function getGitHash(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

// https://vite.dev/config/
export default defineConfig({
  define: {
    __GIT_HASH__: JSON.stringify(getGitHash()),
  },
  plugins: [
    vue(),
    vueDevTools(),
    tailwindcss(),
    cloudflare(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['test/**/*.test.ts'],
  },
});
