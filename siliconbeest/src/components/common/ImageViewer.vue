<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

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
      class="fixed inset-0 z-[100] bg-slate-950/95 backdrop-blur-sm flex items-center justify-center"
      @click.self="emit('close')"
    >
      <!-- Close button -->
      <button
        @click="emit('close')"
        class="absolute top-4 right-4 z-10 rounded-full bg-white/10 p-2 text-white backdrop-blur-md transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
        :aria-label="t('common.close')"
      >
        <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M6 18 18 6M6 6l12 12"/>
        </svg>
      </button>

      <!-- Counter -->
      <div
        v-if="hasMultiple"
        class="absolute top-4 left-1/2 -translate-x-1/2 z-10 rounded-full bg-white/10 px-3 py-1 text-sm font-medium text-white backdrop-blur-md"
      >
        {{ currentIndex + 1 }} / {{ images.length }}
      </div>

      <!-- Prev button -->
      <button
        v-if="hasMultiple && currentIndex > 0"
        @click.stop="prev"
        class="absolute left-4 z-10 rounded-full bg-white/10 p-3 text-white backdrop-blur-md transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
        :aria-label="t('common.previous')"
      >
        <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15.75 19.5 8.25 12l7.5-7.5"/>
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
        class="absolute right-4 z-10 rounded-full bg-white/10 p-3 text-white backdrop-blur-md transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
        :aria-label="t('common.next')"
      >
        <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="m8.25 4.5 7.5 7.5-7.5 7.5"/>
        </svg>
      </button>

      <!-- Alt text -->
      <div
        v-if="currentImage?.description"
        class="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 max-w-[80vw] rounded-2xl bg-slate-950/80 px-4 py-2.5 text-sm text-center text-slate-100 backdrop-blur-md"
      >
        {{ currentImage.description }}
      </div>
    </div>
  </Teleport>
</template>
