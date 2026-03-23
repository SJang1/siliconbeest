<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  src?: string
  alt?: string
  size?: 'sm' | 'md' | 'lg' | 'xl'
}>(), {
  src: '',
  alt: '',
  size: 'md',
})

const sizeClasses: Record<string, string> = {
  sm: 'w-8 h-8 text-xs',
  md: 'w-10 h-10 text-sm',
  lg: 'w-14 h-14 text-base',
  xl: 'w-20 h-20 text-xl',
}

const initials = computed(() => {
  if (!props.alt) return '?'
  return props.alt
    .split(' ')
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()
})

const hasImage = computed(() => !!props.src)
</script>

<template>
  <div
    class="rounded-full overflow-hidden flex-shrink-0 inline-flex items-center justify-center bg-gray-200 dark:bg-gray-700"
    :class="sizeClasses[size]"
  >
    <img
      v-if="hasImage"
      :src="src"
      :alt="alt"
      class="w-full h-full object-cover"
      loading="lazy"
    />
    <span v-else class="font-semibold text-gray-600 dark:text-gray-300" aria-hidden="true">
      {{ initials }}
    </span>
  </div>
</template>
