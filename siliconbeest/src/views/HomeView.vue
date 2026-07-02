<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { useUiStore, type ColumnType } from '@/stores/ui'
import AppShell from '@/components/layout/AppShell.vue'
import TimelineColumn from '@/components/timeline/TimelineColumn.vue'
import NotificationsColumn from '@/components/timeline/NotificationsColumn.vue'
import HomeColumn from '@/components/timeline/HomeColumn.vue'

const { t } = useI18n()
const auth = useAuthStore()
const ui = useUiStore()

const MIN_COLUMN_WIDTH = 320
const gridContainer = ref<HTMLElement | null>(null)
const containerWidth = ref(0)
let resizeObserver: ResizeObserver | null = null

const columns = computed(() => ui.columns)

const maxVisibleCount = computed(() => {
  if (containerWidth.value === 0) return 1
  return Math.max(1, Math.floor(containerWidth.value / MIN_COLUMN_WIDTH))
})

const visibleColumns = computed(() => {
  return columns.value.slice(0, maxVisibleCount.value)
})

onMounted(() => {
  if (gridContainer.value) {
    containerWidth.value = gridContainer.value.clientWidth
    resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        containerWidth.value = entry.contentRect.width
      }
    })
    resizeObserver.observe(gridContainer.value)
  }
})

onUnmounted(() => {
  resizeObserver?.disconnect()
})

function getColumnTitle(type: ColumnType): string {
  const map: Record<ColumnType, string> = {
    home: t('nav.home'),
    local: t('nav.local_timeline'),
    federated: t('nav.federated_timeline'),
    notifications: t('nav.notifications'),
  }
  return map[type]
}

function getTimelineType(type: ColumnType): 'home' | 'local' | 'public' {
  if (type === 'federated') return 'public'
  if (type === 'local') return 'local'
  return 'home'
}

function getBannerKey(type: ColumnType): string {
  return `siliconbeest_banner_dismissed_${type}`
}

function getBannerText(type: ColumnType): string {
  const map: Record<string, string> = {
    local: t('timeline.local_banner'),
    federated: t('timeline.federated_banner'),
  }
  return map[type] || ''
}
</script>

<template>
  <AppShell contained-main>
    <div
      ref="gridContainer"
      class="grid h-full min-h-0"
      :style="{ gridTemplateColumns: `repeat(${visibleColumns.length || 1}, 1fr)` }"
    >
      <div
        v-for="(col, index) in visibleColumns"
        :key="`col-${index}-${col}`"
        class="h-full min-h-0 min-w-0 overflow-hidden border-r border-outline dark:border-outline-dark"
      >
        <HomeColumn v-if="col === 'home'" />
        <NotificationsColumn v-else-if="col === 'notifications'" />
        <TimelineColumn
          v-else
          :timeline-type="getTimelineType(col)"
          :title="getColumnTitle(col)"
          :banner-storage-key="`${getBannerKey(col)}_${index}`"
          :banner-text="getBannerText(col)"
        />
      </div>

      <!-- Fallback if no columns configured -->
      <div v-if="columns.length === 0" class="sb-empty h-full min-h-0 px-6">
        <span class="flex h-12 w-12 items-center justify-center rounded-full bg-surface-2 dark:bg-surface-2-dark">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="h-6 w-6 text-slate-400 dark:text-slate-500" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9 4.5v15m6-15v15m-10.875 0h15.75c.621 0 1.125-.504 1.125-1.125V5.625c0-.621-.504-1.125-1.125-1.125H4.125C3.504 4.5 3 5.004 3 5.625v12.75c0 .621.504 1.125 1.125 1.125Z" />
          </svg>
        </span>
        <p class="text-sm">{{ t('settings.columns_desc') }}</p>
      </div>
    </div>
  </AppShell>
</template>
