<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const props = defineProps<{
  attachments: Array<{
    id: string
    type: string
    url: string
    preview_url: string | null
    description?: string | null
  }>
}>()

const emit = defineEmits<{
  expand: [index: number]
}>()

const visualAttachments = computed(() =>
  props.attachments.filter((a) => a.type !== 'audio')
)
const audioAttachments = computed(() =>
  props.attachments.filter((a) => a.type === 'audio')
)

const gridClass = computed(() => {
  const count = visualAttachments.value.length
  if (count === 0) return ''
  if (count === 1) return 'grid-cols-1'
  if (count === 2) return 'grid-cols-2'
  if (count === 3) return 'grid-cols-2 grid-rows-2 aspect-video'
  return 'grid-cols-2'
})
</script>

<template>
  <div>
    <!-- Visual media (images, video) -->
    <div
      v-if="visualAttachments.length"
      class="grid gap-1.5 overflow-hidden rounded-xl ring-1 ring-outline/60 dark:ring-outline-dark/60"
      :class="gridClass"
      role="group"
      :aria-label="t('status.media_gallery')"
    >
      <button
        v-for="(attachment, index) in visualAttachments.slice(0, 4)"
        :key="attachment.id"
        @click="emit('expand', index)"
        class="group relative min-h-0 cursor-zoom-in overflow-hidden bg-surface-2 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-500 dark:bg-surface-2-dark"
        :class="{
          'aspect-video': visualAttachments.length !== 3,
          'row-span-2': visualAttachments.length === 3 && index === 0,
        }"
      >
        <img
          v-if="attachment.type === 'image' || attachment.type === 'gifv'"
          :src="attachment.preview_url ?? attachment.url"
          :alt="attachment.description || t('status.media_no_alt')"
          class="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          loading="lazy"
        />
        <video
          v-else-if="attachment.type === 'video'"
          :src="attachment.url + '#t=0.1'"
          :poster="attachment.preview_url && attachment.preview_url !== attachment.url ? attachment.preview_url : undefined"
          preload="metadata"
          class="w-full h-full object-cover"
          muted
          playsinline
        />

        <!-- Play icon overlay for video -->
        <div
          v-if="attachment.type === 'video'"
          class="absolute inset-0 flex items-center justify-center"
        >
          <div class="flex h-12 w-12 items-center justify-center rounded-full bg-slate-950/50 backdrop-blur-sm transition-colors group-hover:bg-slate-950/70">
            <svg class="w-6 h-6 text-white ml-0.5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        </div>

        <!-- Hover overlay with zoom icon (images only) -->
        <div
          v-if="attachment.type !== 'video'"
          class="absolute inset-0 flex items-center justify-center bg-slate-950/0 transition-colors duration-200 group-hover:bg-slate-950/25"
        >
          <svg class="w-8 h-8 text-white opacity-0 group-hover:opacity-80 transition-opacity duration-200 drop-shadow-lg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607zM10.5 7.5v6m3-3h-6" />
          </svg>
        </div>

        <!-- Alt badge -->
        <span
          v-if="attachment.description"
          class="absolute bottom-1.5 left-1.5 rounded-md bg-slate-950/70 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-white backdrop-blur-sm"
        >
          ALT
        </span>
      </button>
    </div>

    <!-- Audio attachments -->
    <div
      v-for="attachment in audioAttachments"
      :key="attachment.id"
      class="rounded-xl border border-outline bg-surface-2/60 p-3 dark:border-outline-dark dark:bg-surface-2-dark/60"
      :class="{ 'mt-1.5': visualAttachments.length > 0 }"
    >
      <div class="flex items-center gap-2 min-w-0">
        <audio
          :src="attachment.url"
          controls
          preload="metadata"
          class="flex-1 min-w-0 h-8"
        />
        <a
          :href="attachment.url"
          download
          class="shrink-0 rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-surface-2 hover:text-brand-600 dark:hover:bg-white/10 dark:hover:text-brand-400"
          :title="t('status.download')"
          @click.stop
        >
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
        </a>
      </div>
      <p v-if="attachment.description" class="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
        {{ attachment.description }}
      </p>
    </div>
  </div>
</template>
