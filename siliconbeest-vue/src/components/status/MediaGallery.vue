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
    description?: string
  }>
}>()

const emit = defineEmits<{
  expand: [index: number]
}>()

const gridClass = computed(() => {
  const count = props.attachments.length
  if (count === 1) return 'grid-cols-1'
  if (count === 2) return 'grid-cols-2'
  return 'grid-cols-2'
})
</script>

<template>
  <div
    class="grid gap-1 rounded-xl overflow-hidden"
    :class="gridClass"
    role="group"
    :aria-label="t('status.media_gallery')"
  >
    <button
      v-for="(attachment, index) in attachments.slice(0, 4)"
      :key="attachment.id"
      @click="emit('expand', index)"
      class="relative aspect-video bg-gray-200 dark:bg-gray-700 overflow-hidden focus:outline-none focus:ring-2 focus:ring-indigo-500"
      :class="{ 'row-span-2': attachments.length === 3 && index === 0 }"
    >
      <img
        v-if="attachment.type === 'image' || attachment.type === 'gifv'"
        :src="attachment.preview_url"
        :alt="attachment.description || t('status.media_no_alt')"
        class="w-full h-full object-cover"
        loading="lazy"
      />
      <video
        v-else-if="attachment.type === 'video'"
        :src="attachment.url"
        class="w-full h-full object-cover"
        muted
        loop
        playsinline
      />

      <!-- Alt badge -->
      <span
        v-if="attachment.description"
        class="absolute bottom-1 left-1 px-1.5 py-0.5 text-[10px] font-bold bg-black/70 text-white rounded"
      >
        ALT
      </span>
    </button>
  </div>
</template>
