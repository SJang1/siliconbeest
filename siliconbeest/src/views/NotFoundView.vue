<script setup lang="ts">
import { useI18n } from 'vue-i18n';

const { t } = useI18n();
</script>

<template>
  <div class="max-w-md mx-auto mt-32 text-center">
    <h1 class="text-6xl font-bold text-gray-300 dark:text-gray-700">404</h1>
    <p class="mt-4 text-lg text-gray-600 dark:text-gray-400">{{ t('error.notFound') }}</p>
    <router-link
      to="/"
      class="mt-6 inline-block px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition"
    >
      {{ t('common.back') }}
    </router-link>
  </div>
</template>
