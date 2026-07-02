<script setup lang="ts">
import { useI18n } from 'vue-i18n';

const { t } = useI18n();
</script>

<template>
  <div class="sb-app relative flex min-h-dvh items-center justify-center overflow-hidden">
    <div class="sb-aurora" aria-hidden="true"></div>
    <div class="relative z-10 mx-auto w-full max-w-md px-4 text-center animate-rise-in">
      <h1 class="sb-heading sb-gradient-text text-8xl leading-none sm:text-9xl">404</h1>
      <p class="mt-6 text-lg text-slate-600 dark:text-slate-300">{{ t('error.notFound') }}</p>
      <router-link
        to="/"
        class="sb-btn sb-btn-primary mt-8 px-6"
      >
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="h-4 w-4" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" d="M2.25 12l8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" />
        </svg>
        {{ t('common.back') }}
      </router-link>
    </div>
  </div>
</template>
