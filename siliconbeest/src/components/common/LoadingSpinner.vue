<script setup lang="ts">
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
</script>

<template>
  <div class="flex items-center justify-center p-8" role="status">
    <svg
      class="animate-spin h-8 w-8"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      :aria-label="t('common.loading')"
    >
      <defs>
        <linearGradient id="sb-spinner-gradient" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#6366f1" />
          <stop offset="50%" stop-color="#8b5cf6" />
          <stop offset="100%" stop-color="#d946ef" />
        </linearGradient>
      </defs>
      <circle
        class="text-slate-400 opacity-25 dark:text-slate-600"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        stroke-width="3"
      />
      <path
        d="M2 12a10 10 0 0 1 20 0"
        stroke="url(#sb-spinner-gradient)"
        stroke-width="3"
        stroke-linecap="round"
      />
    </svg>
    <span class="sr-only">{{ t('common.loading') }}</span>
  </div>
</template>
