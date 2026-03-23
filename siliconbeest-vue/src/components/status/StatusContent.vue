<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

defineProps<{
  content: string
  spoilerText?: string
  sensitive?: boolean
}>()

const revealed = ref(false)
</script>

<template>
  <div class="mt-1">
    <!-- CW / Spoiler -->
    <div v-if="spoilerText">
      <p class="text-sm text-gray-700 dark:text-gray-300">{{ spoilerText }}</p>
      <button
        @click="revealed = !revealed"
        class="mt-1 px-3 py-1 text-xs font-semibold rounded bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
        :aria-expanded="revealed"
      >
        {{ revealed ? t('status.show_less') : t('status.show_more') }}
      </button>
    </div>

    <!-- Content (hidden behind CW if spoiler_text present) -->
    <div
      v-if="!spoilerText || revealed"
      class="prose prose-sm dark:prose-invert max-w-none mt-1 break-words"
      v-html="content"
    />
  </div>
</template>
