<script setup lang="ts">
import { onMounted } from 'vue'

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
  success: 'bg-green-600 text-white',
  error: 'bg-red-600 text-white',
  info: 'bg-gray-800 text-white dark:bg-gray-200 dark:text-gray-900',
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
    class="fixed bottom-20 lg:bottom-6 left-1/2 -translate-x-1/2 z-[100] px-4 py-3 rounded-lg shadow-lg max-w-sm animate-slide-up"
    :class="typeClasses[type]"
  >
    <div class="flex items-center gap-3">
      <span class="text-sm font-medium">{{ message }}</span>
      <button
        @click="emit('dismiss')"
        class="ml-2 opacity-70 hover:opacity-100 transition-opacity"
        aria-label="Dismiss"
      >
        &times;
      </button>
    </div>
  </div>
</template>
