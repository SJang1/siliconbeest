<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useNotificationsStore } from '@/stores/notifications'
import { useAnnouncementsStore } from '@/stores/announcements'
import { useDeckColumns } from '../composables/useDeckColumns'
import type { ColumnType } from '@/stores/ui'
import Avatar from '@/components/common/Avatar.vue'

defineProps<{
  showMobileDeck?: boolean
}>()

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const notifStore = useNotificationsStore()
const announcementsStore = useAnnouncementsStore()

// Same-origin: the worker always serves /thumbnail.png (SVG fallback inside)
const instanceIcon = '/thumbnail.png'
const { columns, configRows, isEnabled, toggle, move, reorder } = useDeckColumns()

// Short labels — the rail buttons are 58px wide, long labels overflow
const COLUMN_META: Record<ColumnType, { emoji: string; labelKey: string }> = {
  home: { emoji: '🏠', labelKey: 'deck.nav_home' },
  social: { emoji: '🫂', labelKey: 'deck.nav_social' },
  local: { emoji: '🦬', labelKey: 'deck.nav_local' },
  federated: { emoji: '📡', labelKey: 'deck.nav_federated' },
  notifications: { emoji: '🔔', labelKey: 'deck.nav_alerts' },
  search: { emoji: '🔭', labelKey: 'nav.search' },
  follow_requests: { emoji: '🤝', labelKey: 'deck.nav_requests' },
}

// Single-timeline navigation entries (after the Deck entry)
const timelineEntries: { type: 'home' | 'social' | 'local' | 'federated'; emoji: string; labelKey: string }[] = [
  { type: 'home', emoji: '🏠', labelKey: 'deck.nav_home' },
  { type: 'local', emoji: '🦬', labelKey: 'deck.nav_local' },
  { type: 'social', emoji: '🫂', labelKey: 'deck.nav_social' },
  { type: 'federated', emoji: '📡', labelKey: 'deck.nav_federated' },
]

const onDeck = computed(() => route.name === 'home')

function isTimelineActive(type: string): boolean {
  return route.name === 'timeline' && route.params.type === type
}

const unreadBadge = computed(() => {
  const n = notifStore.unreadCount
  return n > 99 ? '99+' : n > 0 ? String(n) : ''
})

const announcementBadge = computed(() => {
  const count = announcementsStore.unreadCount
  return count > 99 ? '99+' : count > 0 ? String(count) : ''
})

const showColumnConfig = ref(false)
const showMore = ref(false)
const showAccount = ref(false)

function closeMenus() {
  showColumnConfig.value = false
  showMore.value = false
  showAccount.value = false
}

watch(() => route.fullPath, closeMenus)

function openColumnConfig() {
  showMore.value = false
  showAccount.value = false
  showColumnConfig.value = !showColumnConfig.value
}

// Drag & drop reordering inside the column-config popover
const dragRow = ref<number | null>(null)

function onDragStart(row: number, event: DragEvent) {
  dragRow.value = row
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    // Firefox needs data for the drag to start
    event.dataTransfer.setData('text/plain', String(row))
  }
}

function onDragOver(row: number, event: DragEvent) {
  event.preventDefault()
  if (dragRow.value === null || dragRow.value === row) return
  if (row >= columns.value.length) return // disabled region is not a drop target
  reorder(dragRow.value, row)
  dragRow.value = row
}

function onDragEnd() {
  dragRow.value = null
}

const moreEntries = computed(() => [
  { path: '/bookmarks', label: t('nav.bookmarks'), emoji: '🔖' },
  { path: '/favourites', label: t('nav.favourites'), emoji: '⭐' },
  { path: '/lists', label: t('nav.lists'), emoji: '📋' },
  { path: '/followed_tags', label: t('nav.followed_tags'), emoji: '#️⃣' },
  { path: '/directory', label: t('nav.directory'), emoji: '📖' },
  { path: '/follow-requests', label: t('nav.follow_requests'), emoji: '🤝' },
  { path: '/about', label: t('nav.about'), emoji: 'ℹ️' },
])

const myProfilePath = computed(() => {
  const acct = auth.currentUser?.acct || auth.currentUser?.username
  return acct ? `/@${acct}` : '/settings/profile'
})

async function logout() {
  closeMenus()
  await auth.logout()
  void router.push('/')
}

function isRouteActive(path: string): boolean {
  return route.path.startsWith(path)
}
</script>

<template>
  <nav
    class="dk-hairline-r w-[78px] flex-none flex-col items-center gap-1.5 px-2.5 py-3.5"
    :aria-label="t('nav.main_navigation')"
  >
    <!-- Deck (multi-column) + column configuration -->
    <div class="relative flex flex-col items-center">
      <router-link
        to="/home"
        class="dk-rail-item no-underline"
        :class="{ 'dk-rail-item-active': onDeck }"
        :title="t('deck.deck')"
        :aria-label="t('deck.deck')"
      >
        <span class="text-[19px]" aria-hidden="true">🗂️</span>
        <span class="dk-rail-label">{{ t('deck.deck') }}</span>
      </router-link>
      <button
        id="deck-column-picker-button"
        type="button"
        class="dk-mono dk-dim-text mt-0.5 cursor-pointer rounded-full border-0 bg-transparent px-2 py-0.5 text-[9px] hover:underline"
        :aria-label="t('deck.columns_title')"
        :aria-describedby="onDeck && columns.length === 0 && !showMobileDeck ? 'deck-empty-columns-guidance' : undefined"
        :aria-expanded="showColumnConfig"
        @click="openColumnConfig"
      >
        ⚏ {{ t('deck.columns_short') }}
      </button>

      <div v-if="showColumnConfig" class="fixed inset-0 z-10" aria-hidden="true" @click="closeMenus" />
      <div v-if="showColumnConfig" class="dk-menu absolute left-full top-0 z-20 ml-2 w-64 p-2.5">
        <div class="dk-mono dk-dim-text mb-2 px-1 text-[10.5px] uppercase tracking-wide">
          {{ t('deck.columns_title') }}
        </div>
        <ul class="flex list-none flex-col gap-1 p-0">
          <li
            v-for="(type, row) in configRows"
            :key="type"
            class="flex items-center gap-2 rounded-[10px] px-2 py-1.5"
            :style="{
              background: row === dragRow ? 'color-mix(in oklab, var(--dk-acc) 18%, transparent)' : 'var(--dk-surface2)',
              opacity: isEnabled(type) ? 1 : 0.55,
            }"
            :draggable="isEnabled(type)"
            @dragstart="onDragStart(row, $event)"
            @dragover="onDragOver(row, $event)"
            @dragend="onDragEnd"
          >
            <span
              v-if="isEnabled(type)"
              class="dk-dim-text cursor-grab select-none text-[13px]"
              :title="t('deck.drag_to_reorder')"
              aria-hidden="true"
            >≡</span>
            <span v-else class="w-[13px]" aria-hidden="true" />
            <img
              v-if="type === 'local'"
              :src="instanceIcon"
              alt=""
              class="h-4 w-4 rounded object-contain"
              aria-hidden="true"
            />
            <span v-else aria-hidden="true">{{ COLUMN_META[type].emoji }}</span>
            <span class="dk-text flex-1 truncate text-[13px]">{{ t(COLUMN_META[type].labelKey) }}</span>
            <template v-if="isEnabled(type)">
              <button
                type="button"
                class="dk-dim-text cursor-pointer rounded border-0 bg-transparent px-1 text-[12px] hover:opacity-70 disabled:opacity-30"
                :disabled="row === 0"
                :aria-label="t('deck.move_up')"
                @click="move(type, -1)"
              >↑</button>
              <button
                type="button"
                class="dk-dim-text cursor-pointer rounded border-0 bg-transparent px-1 text-[12px] hover:opacity-70 disabled:opacity-30"
                :disabled="row === columns.length - 1"
                :aria-label="t('deck.move_down')"
                @click="move(type, 1)"
              >↓</button>
            </template>
            <input
              type="checkbox"
              class="h-4 w-4 cursor-pointer accent-[var(--dk-acc)]"
              :checked="isEnabled(type)"
              :aria-label="t('deck.toggle_column', { name: t(COLUMN_META[type].labelKey) })"
              @change="toggle(type)"
            />
          </li>
        </ul>
      </div>
    </div>

    <div class="dk-hairline-b my-1 w-10" aria-hidden="true" />
    <span class="dk-rail-caption" aria-hidden="true">{{ t('deck.section_timelines') }}</span>

    <!-- Single timelines: Home | Local | Social | Federated -->
    <router-link
      v-for="entry in timelineEntries"
      :key="entry.type"
      :to="`/timelines/${entry.type}`"
      class="dk-rail-item no-underline"
      :class="{ 'dk-rail-item-active': isTimelineActive(entry.type) }"
      :title="t(entry.labelKey)"
      :aria-label="t(entry.labelKey)"
    >
      <img
        v-if="entry.type === 'local'"
        :src="instanceIcon"
        alt=""
        class="h-[19px] w-[19px] rounded-[5px] object-contain"
        aria-hidden="true"
      />
      <span v-else class="text-[19px]" aria-hidden="true">{{ entry.emoji }}</span>
      <span class="dk-rail-label">{{ t(entry.labelKey) }}</span>
    </router-link>

    <div class="dk-hairline-b my-1 w-10" aria-hidden="true" />

    <!-- Announcements -->
    <router-link
      v-if="auth.isAuthenticated"
      to="/announcements"
      class="dk-rail-item no-underline"
      :class="{ 'dk-rail-item-active': isRouteActive('/announcements') }"
      :title="t('nav.announcements')"
      :aria-label="t('nav.announcements')"
    >
      <span class="text-[19px]" aria-hidden="true">📢</span>
      <span class="dk-rail-label">{{ t('nav.announcements') }}</span>
      <span v-if="announcementBadge" class="dk-rail-badge">{{ announcementBadge }}</span>
    </router-link>

    <!-- Alerts (notifications) -->
    <router-link
      v-if="auth.isAuthenticated"
      to="/notifications"
      class="dk-rail-item no-underline"
      :class="{ 'dk-rail-item-active': isRouteActive('/notifications') }"
      :title="t('nav.notifications')"
      :aria-label="t('nav.notifications')"
    >
      <span class="text-[19px]" aria-hidden="true">🔔</span>
      <span class="dk-rail-label">{{ t('deck.nav_alerts') }}</span>
      <span v-if="unreadBadge" class="dk-rail-badge">{{ unreadBadge }}</span>
    </router-link>

    <!-- Search -->
    <router-link
      to="/search"
      class="dk-rail-item no-underline"
      :class="{ 'dk-rail-item-active': isRouteActive('/search') }"
      :title="t('nav.search')"
      :aria-label="t('nav.search')"
    >
      <span class="text-[19px]" aria-hidden="true">🔭</span>
      <span class="dk-rail-label">{{ t('nav.search') }}</span>
    </router-link>

    <!-- More menu -->
    <div class="relative">
      <button
        type="button"
        class="dk-rail-item"
        :class="{ 'dk-rail-item-active': showMore }"
        :title="t('nav.more')"
        :aria-label="t('nav.more')"
        :aria-expanded="showMore"
        @click="showAccount = false; showColumnConfig = false; showMore = !showMore"
      >
        <span class="text-[19px]" aria-hidden="true">⋯</span>
        <span class="dk-rail-label">{{ t('nav.more') }}</span>
      </button>
      <div v-if="showMore" class="fixed inset-0 z-10" aria-hidden="true" @click="closeMenus" />
      <div v-if="showMore" class="dk-menu absolute left-full top-0 z-20 ml-2 w-52">
        <router-link
          v-for="entry in moreEntries"
          :key="entry.path"
          :to="entry.path"
          class="dk-menu-item no-underline"
          @click="closeMenus"
        >
          <span aria-hidden="true">{{ entry.emoji }}</span>
          <span>{{ entry.label }}</span>
        </router-link>
      </div>
    </div>

    <!-- Settings -->
    <router-link
      v-if="auth.isAuthenticated"
      to="/settings"
      class="dk-rail-item no-underline"
      :class="{ 'dk-rail-item-active': isRouteActive('/settings') }"
      :title="t('nav.settings')"
      :aria-label="t('nav.settings')"
    >
      <span class="text-[19px]" aria-hidden="true">⚙️</span>
      <span class="dk-rail-label">{{ t('nav.settings') }}</span>
    </router-link>

    <!-- Admin -->
    <router-link
      v-if="auth.isAdmin || auth.isModerator"
      to="/admin"
      class="dk-rail-item no-underline"
      :class="{ 'dk-rail-item-active': isRouteActive('/admin') }"
      :title="t('nav.admin')"
      :aria-label="t('nav.admin')"
    >
      <span class="text-[19px]" aria-hidden="true">🛡️</span>
      <span class="dk-rail-label">{{ t('nav.admin') }}</span>
    </router-link>

    <div class="flex-1" />

    <!-- Account menu -->
    <div v-if="auth.isAuthenticated" class="relative">
      <button
        type="button"
        class="grid h-11 w-11 cursor-pointer place-items-center overflow-hidden rounded-[14px] border-2 transition-transform hover:scale-105"
        style="border-color: var(--dk-acc)"
        :title="auth.currentUser?.display_name || auth.currentUser?.username"
        :aria-label="t('nav.profile')"
        :aria-expanded="showAccount"
        @click="showMore = false; showColumnConfig = false; showAccount = !showAccount"
      >
        <Avatar :src="auth.currentUser?.avatar" :alt="auth.currentUser?.display_name || ''" size="sm" />
      </button>
      <div v-if="showAccount" class="fixed inset-0 z-10" aria-hidden="true" @click="closeMenus" />
      <div v-if="showAccount" class="dk-menu absolute bottom-0 left-full z-20 ml-2 w-52">
        <router-link :to="myProfilePath" class="dk-menu-item no-underline" @click="closeMenus">
          <span aria-hidden="true">👤</span><span>{{ t('nav.profile') }}</span>
        </router-link>
        <router-link to="/aurora/home" class="dk-menu-item no-underline" @click="closeMenus">
          <span aria-hidden="true">🌌</span><span>{{ t('deck.design_aurora') }}</span>
        </router-link>
        <a href="/old/" class="dk-menu-item no-underline" @click="closeMenus">
          <span aria-hidden="true">🕰️</span><span>{{ t('deck.design_classic') }}</span>
        </a>
        <button type="button" class="dk-menu-item" @click="logout">
          <span aria-hidden="true">🚪</span><span>{{ t('auth.logout') }}</span>
        </button>
      </div>
    </div>
  </nav>
</template>
