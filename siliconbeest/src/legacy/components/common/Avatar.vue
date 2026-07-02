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

// Default avatar as inline SVG data URI
const DEFAULT_AVATAR = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' fill='%236366f1'/%3E%3Ccircle cx='50' cy='38' r='18' fill='%23e0e7ff'/%3E%3Cellipse cx='50' cy='80' rx='28' ry='22' fill='%23e0e7ff'/%3E%3C/svg%3E"

const resolvedSrc = computed(() => props.src || DEFAULT_AVATAR)
const hasImage = computed(() => true) // always show image (default or custom)
</script>

<template>
  <div
    class="rounded-full overflow-hidden flex-shrink-0 inline-flex items-center justify-center bg-gray-200 dark:bg-gray-700"
    :class="sizeClasses[size]"
  >
    <img
      v-if="hasImage"
      :src="resolvedSrc"
      :alt="alt"
      class="w-full h-full object-cover"
      loading="lazy"
    />
    <span v-else class="font-semibold text-gray-600 dark:text-gray-300" aria-hidden="true">
      {{ initials }}
    </span>
  </div>
</template>
