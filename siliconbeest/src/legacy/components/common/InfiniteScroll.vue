<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue'
import LoadingSpinner from './LoadingSpinner.vue'

const props = defineProps<{
  loading?: boolean
  done?: boolean
}>()

const emit = defineEmits<{
  'load-more': []
}>()

const sentinel = ref<HTMLElement | null>(null)
let observer: IntersectionObserver | null = null

onMounted(() => {
  if (!sentinel.value) return
  observer = new IntersectionObserver(
    (entries) => {
      if (entries[0]?.isIntersecting && !props.loading && !props.done) {
        emit('load-more')
      }
    },
    { rootMargin: '200px' }
  )
  observer.observe(sentinel.value)
})

watch(() => props.done, (isDone) => {
  if (isDone) observer?.disconnect()
})

onUnmounted(() => {
  observer?.disconnect()
})
</script>

<template>
  <div>
    <slot />
    <div ref="sentinel" class="h-1" aria-hidden="true" />
    <LoadingSpinner v-if="loading" />
  </div>
</template>
