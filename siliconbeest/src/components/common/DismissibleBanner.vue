<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const props = defineProps<{
  storageKey: string
}>()

const dismissed = ref(
  typeof localStorage !== 'undefined' && localStorage.getItem(props.storageKey) === 'true'
)

function dismiss() {
  dismissed.value = true
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(props.storageKey, 'true')
  }
}
</script>

<template>
  <div
    v-if="!dismissed"
    class="flex items-start gap-3 border-b border-brand-100 bg-brand-50/80 px-4 py-3 dark:border-brand-900/60 dark:bg-brand-950/40"
  >
    <span class="mt-0.5 flex-shrink-0 text-brand-500 dark:text-brand-400">
      <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="m11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z" />
      </svg>
    </span>
    <div class="flex-1 text-sm text-brand-950 dark:text-brand-100">
      <slot />
    </div>
    <button
      @click="dismiss"
      class="flex-shrink-0 rounded-full p-1 text-brand-400 transition-colors hover:bg-brand-100 hover:text-brand-600 dark:text-brand-500 dark:hover:bg-brand-900/50 dark:hover:text-brand-300"
      :aria-label="t('common.dismiss')"
    >
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18 18 6M6 6l12 12" />
      </svg>
    </button>
  </div>
</template>
