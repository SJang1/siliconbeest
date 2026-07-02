<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'

const props = defineProps<{
  images: Array<{
    url: string
    description?: string
    type?: string
  }>
  initialIndex?: number
}>()

const emit = defineEmits<{
  close: []
}>()

const currentIndex = ref(props.initialIndex ?? 0)
const zoomed = ref(false)

const currentImage = computed(() => props.images[currentIndex.value])
const hasMultiple = computed(() => props.images.length > 1)

function prev() {
  if (currentIndex.value > 0) {
    currentIndex.value--
    zoomed.value = false
  }
}

function next() {
  if (currentIndex.value < props.images.length - 1) {
    currentIndex.value++
    zoomed.value = false
  }
}

function toggleZoom() {
  zoomed.value = !zoomed.value
}

function handleKeydown(e: KeyboardEvent) {
  switch (e.key) {
    case 'Escape':
      emit('close')
      break
    case 'ArrowLeft':
      prev()
      break
    case 'ArrowRight':
      next()
      break
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown)
  document.body.style.overflow = 'hidden'
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
  document.body.style.overflow = ''
})
</script>

<template>
  <Teleport to="body">
    <div
      class="fixed inset-0 z-[100] bg-black/95 flex items-center justify-center"
      @click.self="emit('close')"
    >
      <!-- Close button -->
      <button
        @click="emit('close')"
        class="absolute top-4 right-4 z-10 p-2 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors"
        aria-label="Close"
      >
        <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
        </svg>
      </button>

      <!-- Counter -->
      <div
        v-if="hasMultiple"
        class="absolute top-4 left-1/2 -translate-x-1/2 z-10 px-3 py-1 rounded-full bg-black/50 text-white text-sm"
      >
        {{ currentIndex + 1 }} / {{ images.length }}
      </div>

      <!-- Prev button -->
      <button
        v-if="hasMultiple && currentIndex > 0"
        @click.stop="prev"
        class="absolute left-4 z-10 p-3 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors"
        aria-label="Previous"
      >
        <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/>
        </svg>
      </button>

      <!-- Image -->
      <div
        class="max-w-[95vw] max-h-[90vh] flex items-center justify-center"
        :class="{ 'cursor-zoom-in': !zoomed, 'cursor-zoom-out': zoomed }"
        @click.stop="toggleZoom"
      >
        <img
          v-if="currentImage && (!currentImage.type || currentImage.type === 'image' || currentImage.type === 'gifv')"
          :src="currentImage.url"
          :alt="currentImage.description || ''"
          class="transition-transform duration-200 select-none"
          :class="zoomed ? 'max-w-none max-h-none scale-150' : 'max-w-[95vw] max-h-[85vh] object-contain'"
          draggable="false"
        />
        <video
          v-else-if="currentImage?.type === 'video'"
          :src="currentImage.url"
          controls
          autoplay
          class="max-w-[95vw] max-h-[85vh]"
        />
      </div>

      <!-- Next button -->
      <button
        v-if="hasMultiple && currentIndex < images.length - 1"
        @click.stop="next"
        class="absolute right-4 z-10 p-3 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors"
        aria-label="Next"
      >
        <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
        </svg>
      </button>

      <!-- Alt text -->
      <div
        v-if="currentImage?.description"
        class="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 max-w-[80vw] px-4 py-2 rounded-lg bg-black/70 text-white text-sm text-center"
      >
        {{ currentImage.description }}
      </div>
    </div>
  </Teleport>
</template>
