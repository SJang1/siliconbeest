<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const props = defineProps<{
  storageKey: string
}>()

const dismissed = ref(localStorage.getItem(props.storageKey) === 'true')

function dismiss() {
  dismissed.value = true
  localStorage.setItem(props.storageKey, 'true')
}
</script>

<template>
  <div
    v-if="!dismissed"
    class="bg-blue-50 dark:bg-blue-900/20 border-b border-blue-200 dark:border-blue-800 px-4 py-3 flex items-start gap-3"
  >
    <span class="text-blue-500 flex-shrink-0 mt-0.5">
      <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
        <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd" />
      </svg>
    </span>
    <div class="flex-1 text-sm text-blue-800 dark:text-blue-200">
      <slot />
    </div>
    <button
      @click="dismiss"
      class="p-1 rounded hover:bg-blue-100 dark:hover:bg-blue-800 text-blue-400 dark:text-blue-500 flex-shrink-0"
      :aria-label="t('common.dismiss')"
    >
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
      </svg>
    </button>
  </div>
</template>
