<script setup lang="ts">
import { computed, ref } from 'vue'
import type { PreviewCard } from '@/types/mastodon'

const props = defineProps<{
  card: PreviewCard
}>()

const imageError = ref(false)
const showImage = computed(() => props.card.image && !imageError.value)

const domain = computed(() => {
  try {
    return new URL(props.card.url).hostname.replace(/^www\./, '')
  } catch {
    return props.card.provider_name || ''
  }
})
</script>

<template>
  <a
    :href="card.url"
    target="_blank"
    rel="noopener noreferrer"
    class="block mt-3 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
  >
    <div class="flex" :class="{ 'flex-col': !showImage, 'flex-row': showImage }">
      <!-- Image -->
      <div
        v-if="showImage"
        class="flex-shrink-0 w-28 h-28 sm:w-32 sm:h-32 bg-gray-100 dark:bg-gray-800"
      >
        <img
          :src="card.image!"
          :alt="card.title"
          class="w-full h-full object-cover"
          loading="lazy"
          @error="imageError = true"
        />
      </div>

      <!-- Text content -->
      <div class="flex-1 min-w-0 p-3">
        <!-- Provider -->
        <div class="text-xs text-gray-500 dark:text-gray-400 truncate mb-0.5">
          {{ card.provider_name || domain }}
        </div>

        <!-- Title -->
        <div
          v-if="card.title"
          class="text-sm font-medium text-gray-900 dark:text-gray-100 line-clamp-2"
        >
          {{ card.title }}
        </div>

        <!-- Description -->
        <div
          v-if="card.description"
          class="text-xs text-gray-500 dark:text-gray-400 line-clamp-2 mt-0.5"
        >
          {{ card.description }}
        </div>
      </div>
    </div>
  </a>
</template>
