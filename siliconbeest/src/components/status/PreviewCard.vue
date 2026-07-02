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
    class="sb-card sb-card-hover mt-3 block overflow-hidden"
  >
    <div class="flex" :class="{ 'flex-col': !showImage, 'flex-row': showImage }">
      <!-- Image -->
      <div
        v-if="showImage"
        class="flex-shrink-0 w-28 h-28 sm:w-32 sm:h-32 bg-surface-2 dark:bg-surface-2-dark"
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
      <div class="min-w-0 flex-1 p-3.5">
        <!-- Provider -->
        <div class="mb-0.5 truncate text-xs font-medium text-slate-400 dark:text-slate-500">
          {{ card.provider_name || domain }}
        </div>

        <!-- Title -->
        <div
          v-if="card.title"
          class="text-sm font-semibold text-slate-900 line-clamp-2 dark:text-slate-100"
        >
          {{ card.title }}
        </div>

        <!-- Description -->
        <div
          v-if="card.description"
          class="mt-0.5 text-xs text-slate-500 line-clamp-2 dark:text-slate-400"
        >
          {{ card.description }}
        </div>
      </div>
    </div>
  </a>
</template>
