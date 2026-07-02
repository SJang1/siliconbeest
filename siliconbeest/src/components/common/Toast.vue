<script setup lang="ts">
import { onMounted } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const props = withDefaults(defineProps<{
  message: string
  type?: 'success' | 'error' | 'info'
  duration?: number
}>(), {
  type: 'info',
  duration: 5000,
})

const emit = defineEmits<{
  dismiss: []
}>()

const typeClasses: Record<string, string> = {
  success: 'border-l-emerald-500 dark:border-l-emerald-400',
  error: 'border-l-red-500 dark:border-l-red-400',
  info: 'border-l-brand-500 dark:border-l-brand-400',
}

const iconClasses: Record<string, string> = {
  success: 'text-emerald-500 dark:text-emerald-400',
  error: 'text-red-500 dark:text-red-400',
  info: 'text-brand-500 dark:text-brand-400',
}

onMounted(() => {
  if (props.duration > 0) {
    setTimeout(() => emit('dismiss'), props.duration)
  }
})
</script>

<template>
  <div
    role="alert"
    class="sb-card animate-rise-in fixed bottom-20 lg:bottom-6 left-1/2 -translate-x-1/2 z-[100] max-w-sm border-l-4 px-4 py-3 shadow-lift"
    :class="typeClasses[type]"
  >
    <div class="flex items-center gap-3">
      <span class="flex-shrink-0" :class="iconClasses[type]" aria-hidden="true">
        <svg v-if="type === 'success'" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
        </svg>
        <svg v-else-if="type === 'error'" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
        </svg>
        <svg v-else class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="m11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z" />
        </svg>
      </span>
      <span class="text-sm font-medium text-slate-800 dark:text-slate-100">{{ message }}</span>
      <button
        @click="emit('dismiss')"
        class="ml-2 flex-shrink-0 rounded-full p-1 text-slate-400 transition-colors hover:bg-surface-2 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-white/10 dark:hover:text-slate-200"
        :aria-label="t('common.dismiss')"
      >
        <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  </div>
</template>
