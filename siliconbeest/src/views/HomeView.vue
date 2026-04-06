<script setup lang="ts">
import { computed, onMounted } from 'vue'
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

const columns = computed(() => ui.columns)

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
  <AppShell>
    <div
      class="grid h-full"
      :style="{ gridTemplateColumns: `repeat(${columns.length || 1}, minmax(320px, 1fr))` }"
    >
      <div
        v-for="(col, index) in columns"
        :key="`col-${index}-${col}`"
        class="border-r border-gray-200 dark:border-gray-700 h-full overflow-y-auto"
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
      <div v-if="columns.length === 0" class="h-full flex items-center justify-center text-gray-400 dark:text-gray-600">
        <p class="text-sm">{{ t('settings.columns_desc') }}</p>
      </div>
    </div>
  </AppShell>
</template>
