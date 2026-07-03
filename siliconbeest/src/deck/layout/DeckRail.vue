<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useNotificationsStore } from '@/stores/notifications'
import { useDeckColumns, type DeckColumnKey } from '../composables/useDeckColumns'
import Avatar from '@/components/common/Avatar.vue'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const notifStore = useNotificationsStore()
const { isVisible, toggle, show } = useDeckColumns()

const timelineEntries: { key: DeckColumnKey; emoji: string; labelKey: string }[] = [
  { key: 'home', emoji: '🏠', labelKey: 'nav.home' },
  { key: 'local', emoji: '🦬', labelKey: 'nav.local_timeline' },
  { key: 'federated', emoji: '📡', labelKey: 'nav.federated_timeline' },
]

const onDeck = computed(() => route.name === 'home')

function onTimelineClick(key: DeckColumnKey) {
  if (onDeck.value) {
    toggle(key)
  } else {
    show(key)
    void router.push('/home')
  }
}

const unreadBadge = computed(() => {
  const n = notifStore.unreadCount
  return n > 99 ? '99+' : n > 0 ? String(n) : ''
})

const showMore = ref(false)
const showAccount = ref(false)

function closeMenus() {
  showMore.value = false
  showAccount.value = false
}

watch(() => route.fullPath, closeMenus)

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
    <!-- Timeline column toggles -->
    <button
      v-for="entry in timelineEntries"
      :key="entry.key"
      type="button"
      class="dk-rail-item"
      :class="{ 'dk-rail-item-active': onDeck && isVisible(entry.key) }"
      :title="t(entry.labelKey)"
      :aria-label="t('deck.toggle_column', { name: t(entry.labelKey) })"
      :aria-pressed="onDeck ? isVisible(entry.key) : undefined"
      @click="onTimelineClick(entry.key)"
    >
      <span class="text-[19px]" aria-hidden="true">{{ entry.emoji }}</span>
      <span class="dk-rail-label">{{ t(entry.labelKey) }}</span>
    </button>

    <div class="dk-hairline-b my-1 w-10" aria-hidden="true" />

    <!-- Notifications -->
    <router-link
      v-if="auth.isAuthenticated"
      to="/notifications"
      class="dk-rail-item no-underline"
      :class="{ 'dk-rail-item-active': isRouteActive('/notifications') }"
      :title="t('nav.notifications')"
      :aria-label="t('nav.notifications')"
    >
      <span class="text-[19px]" aria-hidden="true">🔔</span>
      <span class="dk-rail-label">{{ t('nav.notifications') }}</span>
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
        @click="showAccount = false; showMore = !showMore"
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
        @click="showMore = false; showAccount = !showAccount"
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
