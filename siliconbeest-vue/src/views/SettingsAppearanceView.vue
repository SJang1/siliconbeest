<script setup lang="ts">
import { useI18n } from 'vue-i18n';

const { t } = useI18n();
</script>

<template>
  <div>
    <h2 class="text-xl font-bold mb-4">{{ t('settings.appearance') }}</h2>
  </div>
</template>
