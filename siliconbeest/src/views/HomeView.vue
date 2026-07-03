<script setup lang="ts">
import { computed, nextTick, ref, watch, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { useUiStore, ALL_COLUMNS, type ColumnType } from '@/stores/ui'
import { useNotificationsStore } from '@/stores/notifications'
import { useInstanceStore } from '@/stores/instance'
import AppShell from '@/components/layout/AppShell.vue'
import TimelineColumn from '@/components/timeline/TimelineColumn.vue'
import NotificationsColumn from '@/components/timeline/NotificationsColumn.vue'
import HomeColumn from '@/components/timeline/HomeColumn.vue'

const { t } = useI18n()
const auth = useAuthStore()
const ui = useUiStore()
const notifStore = useNotificationsStore()
const instanceStore = useInstanceStore()

// Instance identity for the mobile deck header
const instanceTitle = computed(
  () => instanceStore.instance?.title || instanceStore.instance?.domain || '',
)
const thumbnailFailed = ref(false)
const instanceThumbnail = computed(() =>
  thumbnailFailed.value ? null : instanceStore.instance?.thumbnail?.url || null,
)
const instanceInitial = computed(() => (instanceTitle.value ? [...instanceTitle.value][0] : 'S'))

const MIN_COLUMN_WIDTH = 320
const gridContainer = ref<HTMLElement | null>(null)
const containerWidth = ref(0)
let resizeObserver: ResizeObserver | null = null

// SSR renders the desktop branch; only switch to the mobile deck after
// hydration so server and client markup match.
const hydrated = ref(false)
const showMobileDeck = computed(() => hydrated.value && ui.isMobile)

const columns = computed(() => ui.columns)

const maxVisibleCount = computed(() => {
  if (containerWidth.value === 0) return 1
  return Math.max(1, Math.floor(containerWidth.value / MIN_COLUMN_WIDTH))
})

const visibleColumns = computed(() => {
  return columns.value.slice(0, maxVisibleCount.value)
})

// ---------------------------------------------------------------------------
// Mobile deck: a single column at a time, but every column type is available.
// Columns mount lazily on first visit and stay mounted (v-show) so switching
// is instant and scroll position is preserved.
// ---------------------------------------------------------------------------
const mobileColumns = ALL_COLUMNS
const visitedMobileColumns = ref<Set<ColumnType>>(new Set([ui.mobileColumn]))
const tabStrip = ref<HTMLElement | null>(null)

watch(
  () => ui.mobileColumn,
  async (col) => {
    if (!visitedMobileColumns.value.has(col)) {
      visitedMobileColumns.value = new Set([...visitedMobileColumns.value, col])
    }
    // Keep the active tab visible when the strip overflows
    await nextTick()
    tabStrip.value
      ?.querySelector('[aria-pressed="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
  },
)

// Heroicons 24 outline paths for the deck tab strip
const columnIcons: Record<ColumnType, string> = {
  home: 'M2.25 12l8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25',
  local: 'M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z',
  federated: 'M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m-18.432 0A8.959 8.959 0 013 12c0-.778.099-1.533.284-2.253',
  notifications: 'M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0',
}

onMounted(() => {
  hydrated.value = true
  resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      containerWidth.value = entry.contentRect.width
    }
  })
})

// The grid container only exists in the desktop branch, so (re-)observe it
// whenever it appears or disappears (e.g. after rotating a tablet).
watch(gridContainer, (el, prev) => {
  if (prev) resizeObserver?.unobserve(prev)
  if (el) {
    containerWidth.value = el.clientWidth
    resizeObserver?.observe(el)
  }
}, { immediate: false })

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
    <!-- Mobile deck: tab strip + one column, all column types selectable -->
    <div v-if="showMobileDeck" class="flex h-full min-h-0 flex-col">
      <header class="sb-glass sticky top-0 z-10 flex items-center gap-1.5 border-b px-2 py-1.5">
        <!-- Instance logo — so users can tell which server they're on -->
        <router-link
          to="/about"
          class="flex min-w-0 shrink-0 items-center gap-1.5 rounded-lg py-1 pl-1 pr-0.5 no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
          :aria-label="instanceTitle || t('nav.about')"
        >
          <img
            v-if="instanceThumbnail"
            :src="instanceThumbnail"
            :alt="instanceTitle"
            class="h-7 w-7 shrink-0 rounded-lg object-cover"
            @error="thumbnailFailed = true"
          />
          <span
            v-else
            class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-linear-to-br from-brand-600 via-violet-600 to-fuchsia-600 text-sm font-bold text-white dark:from-brand-500 dark:via-violet-500 dark:to-fuchsia-500"
            aria-hidden="true"
          >{{ instanceInitial }}</span>
          <span class="sb-heading sb-gradient-text max-w-[5.5rem] truncate text-base leading-tight">{{ instanceTitle }}</span>
        </router-link>

        <div class="h-6 w-px shrink-0 bg-outline dark:bg-outline-dark" aria-hidden="true" />

        <nav
          ref="tabStrip"
          class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
          :aria-label="t('settings.columns')"
        >
          <button
            v-for="type in mobileColumns"
            :key="type"
            @click="ui.setMobileColumn(type)"
            class="relative flex shrink-0 touch-manipulation items-center gap-1.5 rounded-full px-3 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
            :class="ui.mobileColumn === type
              ? 'bg-brand-50 text-brand-700 dark:bg-brand-950/60 dark:text-brand-300'
              : 'text-slate-500 hover:bg-surface-2 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-surface-2-dark dark:hover:text-slate-200'"
            :aria-pressed="ui.mobileColumn === type"
          >
            <svg class="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" :d="columnIcons[type]" />
            </svg>
            <span v-if="ui.mobileColumn === type" class="whitespace-nowrap">{{ getColumnTitle(type) }}</span>
            <span
              v-if="type === 'notifications' && notifStore.unreadCount > 0"
              class="flex h-4 min-w-[16px] items-center justify-center rounded-full bg-linear-to-r from-brand-600 to-fuchsia-600 px-1 text-[10px] font-bold text-white dark:from-brand-500 dark:to-fuchsia-500"
            >{{ notifStore.unreadCount > 99 ? '99+' : notifStore.unreadCount }}</span>
          </button>
        </nav>

        <!-- Compact compose button: icon only, always fits on one line -->
        <button
          v-if="auth.isAuthenticated"
          @click="ui.openComposeModal()"
          class="flex h-9 w-9 shrink-0 touch-manipulation items-center justify-center rounded-full bg-linear-to-r from-brand-600 via-violet-600 to-fuchsia-600 text-white shadow-soft transition-all active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 dark:from-brand-500 dark:via-violet-500 dark:to-fuchsia-500"
          :aria-label="t('nav.compose')"
        >
          <svg class="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" />
          </svg>
        </button>
      </header>

      <div class="relative min-h-0 flex-1">
        <div
          v-for="type in mobileColumns"
          v-show="ui.mobileColumn === type"
          :key="`mobile-${type}`"
          class="h-full min-h-0"
        >
          <template v-if="visitedMobileColumns.has(type)">
            <HomeColumn v-if="type === 'home'" hide-header />
            <NotificationsColumn v-else-if="type === 'notifications'" hide-header />
            <TimelineColumn
              v-else
              hide-header
              :timeline-type="getTimelineType(type)"
              :title="getColumnTitle(type)"
              :banner-storage-key="getBannerKey(type)"
              :banner-text="getBannerText(type)"
            />
          </template>
        </div>
      </div>
    </div>

    <!-- Desktop deck: side-by-side columns -->
    <div
      v-else
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
