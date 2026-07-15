<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useUiStore, ALL_COLUMNS, type ColumnType } from '@/stores/ui'
import { useNotificationsStore } from '@/stores/notifications'
import { withCurrentDesign } from '@/utils/safeRedirect'

const { t } = useI18n()
const auth = useAuthStore()
const ui = useUiStore()
const notifStore = useNotificationsStore()
const router = useRouter()
const route = useRoute()

const menuOpen = ref(false)
const navigating = ref(false)

const isOnDeck = computed(() => route.path === designedPath('/home'))

function designedPath(path: string): string {
  return withCurrentDesign(path, route.path)
}

// Heroicons 24 outline paths for the deck column picker
const columnIcons: Record<ColumnType, string> = {
  home: 'M2.25 12l8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25',
  local: 'M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z',
  federated: 'M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m-18.432 0A8.959 8.959 0 013 12c0-.778.099-1.533.284-2.253',
  notifications: 'M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0',
  social: 'M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z',
  search: 'M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z',
  follow_requests: 'M18 7.5v3m0 0v3m0-3h3m-3 0h-3m-2.25-4.125a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zM3 19.235v-.11a6.375 6.375 0 0112.75 0v.109A12.318 12.318 0 019.374 21c-2.331 0-4.512-.645-6.374-1.766z',
}

function getColumnTitle(type: ColumnType): string {
  const map: Record<ColumnType, string> = {
    home: t('nav.home'),
    local: t('nav.local_timeline'),
    federated: t('nav.federated_timeline'),
    notifications: t('nav.notifications'),
    social: t('nav.social_timeline'),
    search: t('nav.search'),
    follow_requests: t('nav.follow_requests'),
  }
  return map[type]
}

// Tapping the deck (home) tab while already on the deck opens the column picker
function handleHomeTab() {
  menuOpen.value = false
  if (isOnDeck.value) {
    ui.toggleDeckMenu()
  }
}

async function selectDeckColumn(type: ColumnType) {
  ui.setMobileColumn(type)
  if (!isOnDeck.value) {
    await navigateTo('/home')
  }
}

const profilePath = computed(() => {
  const acct = auth.currentUser?.acct
  return designedPath(acct ? `/@${acct}` : '/settings')
})

// Heroicons 24 outline path data (presentation only)
const tabs = computed(() => [
  { key: 'home', path: designedPath('/home'), icon: 'M2.25 12l8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25', action: null },
  { key: 'explore', path: designedPath('/explore/local'), icon: 'M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z', action: null },
  { key: 'compose', path: null, icon: 'M12 4.5v15m7.5-7.5h-15', action: () => ui.openComposeModal() },
  { key: 'notifications', path: designedPath('/notifications'), icon: 'M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0', action: null },
  { key: 'profile', path: profilePath.value, icon: 'M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z', action: null },
])

function handleTab(tab: { path: string | null; action: (() => void) | null }) {
  ui.closeDeckMenu()
  if (tab.action) {
    tab.action()
  }
}

async function navigateTo(path: string) {
  menuOpen.value = false
  ui.closeDeckMenu()
  await nextTick()

  const target = designedPath(path)
  if (navigating.value || router.currentRoute.value.fullPath === target) return
  navigating.value = true
  try {
    await router.push(target)
  } catch {
    // Ignore cancelled/duplicated navigations caused by rapid taps.
  } finally {
    navigating.value = false
  }
}

async function signOut() {
  menuOpen.value = false
  await auth.logout()
  await router.push(designedPath('/login'))
}

onBeforeRouteLeave(() => {
  menuOpen.value = false
  ui.closeDeckMenu()
})
</script>

<template>
  <!-- Deck column picker (opens when the deck tab is tapped again) -->
  <Teleport to="body">
    <div
      v-if="ui.deckMenuOpen"
      class="fixed inset-0 bg-slate-950/40 backdrop-blur-sm z-[60] md:hidden"
      @click="ui.closeDeckMenu()"
    />
    <div
      v-if="ui.deckMenuOpen"
      class="sb-card fixed inset-x-3 bottom-[calc(max(0.75rem,env(safe-area-inset-bottom))+4.5rem)] z-[61] max-h-[calc(100dvh-6.5rem)] overflow-y-auto overscroll-contain shadow-lift animate-rise-in md:hidden"
      role="menu"
      :aria-label="t('settings.columns')"
    >
      <div class="p-2 space-y-0.5">
        <p class="px-4 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
          {{ t('settings.columns') }}
        </p>
        <button
          v-for="type in ALL_COLUMNS"
          :key="type"
          @click="selectDeckColumn(type)"
          class="sb-menu-item touch-manipulation gap-3 py-3 text-left"
          :class="ui.mobileColumn === type ? 'bg-brand-50 font-semibold text-brand-700 dark:bg-brand-950/50 dark:text-brand-300' : ''"
          role="menuitemradio"
          :aria-checked="ui.mobileColumn === type"
        >
          <svg class="h-5 w-5 shrink-0" :class="ui.mobileColumn === type ? 'text-brand-500 dark:text-brand-400' : 'text-slate-400 dark:text-slate-500'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" :d="columnIcons[type]" />
          </svg>
          <span class="flex-1">{{ getColumnTitle(type) }}</span>
          <span
            v-if="type === 'notifications' && notifStore.unreadCount > 0"
            class="flex h-4 min-w-[16px] items-center justify-center rounded-full bg-linear-to-r from-brand-600 to-fuchsia-600 px-1 text-[10px] font-bold text-white dark:from-brand-500 dark:to-fuchsia-500"
          >{{ notifStore.unreadCount > 99 ? '99+' : notifStore.unreadCount }}</span>
          <svg v-if="ui.mobileColumn === type" class="h-5 w-5 shrink-0 text-brand-500 dark:text-brand-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" />
          </svg>
        </button>
      </div>
    </div>
  </Teleport>

  <!-- Slide-up menu overlay -->
  <Teleport to="body">
    <div
      v-if="menuOpen"
      class="fixed inset-0 bg-slate-950/40 backdrop-blur-sm z-[60] md:hidden"
      @click="menuOpen = false"
    />
    <div
      v-if="menuOpen"
      class="sb-card fixed inset-x-3 bottom-[calc(max(0.75rem,env(safe-area-inset-bottom))+4.5rem)] z-[61] max-h-[calc(100dvh-6.5rem)] overflow-y-auto overscroll-contain shadow-lift animate-rise-in md:hidden"
    >
      <div class="p-2 space-y-0.5">
        <!-- User info -->
        <div v-if="auth.currentUser" class="mb-1 border-b border-outline px-4 py-3 dark:border-outline-dark">
          <p class="font-semibold text-slate-900 dark:text-white">{{ auth.currentUser.display_name || auth.currentUser.username }}</p>
          <p class="text-sm text-slate-500 dark:text-slate-400">@{{ auth.currentUser.acct }}</p>
        </div>

        <button @click="navigateTo(profilePath)" class="sb-menu-item gap-3 py-3 text-left">
          <svg class="h-5 w-5 shrink-0 text-slate-400 dark:text-slate-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
          </svg>
          <span>{{ t('nav.profile') }}</span>
        </button>
        <button @click="navigateTo('/explore/local')" class="sb-menu-item gap-3 py-3 text-left">
          <svg class="h-5 w-5 shrink-0 text-slate-400 dark:text-slate-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
          </svg>
          <span>{{ t('nav.local_timeline') }}</span>
        </button>
        <button @click="navigateTo('/explore/public')" class="sb-menu-item gap-3 py-3 text-left">
          <svg class="h-5 w-5 shrink-0 text-slate-400 dark:text-slate-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m-18.432 0A8.959 8.959 0 013 12c0-.778.099-1.533.284-2.253" />
          </svg>
          <span>{{ t('nav.federated_timeline') }}</span>
        </button>
        <button @click="navigateTo('/search')" class="sb-menu-item gap-3 py-3 text-left">
          <svg class="h-5 w-5 shrink-0 text-slate-400 dark:text-slate-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
          </svg>
          <span>{{ t('nav.search') }}</span>
        </button>
        <button @click="navigateTo('/bookmarks')" class="sb-menu-item gap-3 py-3 text-left">
          <svg class="h-5 w-5 shrink-0 text-slate-400 dark:text-slate-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0111.186 0z" />
          </svg>
          <span>{{ t('nav.bookmarks') }}</span>
        </button>
        <button @click="navigateTo('/favourites')" class="sb-menu-item gap-3 py-3 text-left">
          <svg class="h-5 w-5 shrink-0 text-slate-400 dark:text-slate-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" />
          </svg>
          <span>{{ t('nav.favourites') }}</span>
        </button>
        <button @click="navigateTo('/lists')" class="sb-menu-item gap-3 py-3 text-left">
          <svg class="h-5 w-5 shrink-0 text-slate-400 dark:text-slate-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 010 3.75H5.625a1.875 1.875 0 010-3.75z" />
          </svg>
          <span>{{ t('nav.lists') }}</span>
        </button>
        <button @click="navigateTo('/settings')" class="sb-menu-item gap-3 py-3 text-left">
          <svg class="h-5 w-5 shrink-0 text-slate-400 dark:text-slate-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          <span>{{ t('nav.settings') }}</span>
        </button>
        <button @click="navigateTo('/about')" class="sb-menu-item gap-3 py-3 text-left">
          <svg class="h-5 w-5 shrink-0 text-slate-400 dark:text-slate-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
          </svg>
          <span>{{ t('nav.about') }}</span>
        </button>
        <button v-if="auth.isAdmin || auth.isModerator" @click="navigateTo('/admin')" class="sb-menu-item gap-3 py-3 text-left">
          <svg class="h-5 w-5 shrink-0 text-slate-400 dark:text-slate-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
          </svg>
          <span>{{ t('nav.admin') }}</span>
        </button>

        <div class="mt-1 border-t border-outline pt-1 dark:border-outline-dark">
          <button @click="signOut" class="sb-menu-item gap-3 py-3 text-left text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30">
            <svg class="h-5 w-5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9" />
            </svg>
            <span>{{ t('settings.sign_out') }}</span>
          </button>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- Bottom tab bar — floating glass dock -->
  <nav
    class="sb-glass fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-50 rounded-2xl border shadow-lift md:hidden"
    :aria-label="t('nav.mobile_navigation')"
  >
    <ul class="flex h-16 items-center justify-around px-1">
      <li v-for="tab in tabs" :key="tab.key">
        <router-link
          v-if="tab.path"
          :to="tab.path"
          class="relative flex h-14 w-14 touch-manipulation flex-col items-center justify-center rounded-xl text-slate-500 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 dark:text-slate-400"
          active-class="text-brand-600 dark:text-brand-400"
          :aria-label="t(`nav.${tab.key}`)"
          @click="tab.key === 'home' && handleHomeTab()"
        >
          <svg class="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" :d="tab.icon" />
          </svg>
          <!-- Hint that re-tapping the deck tab opens the column picker -->
          <svg
            v-if="tab.key === 'home' && isOnDeck"
            class="absolute bottom-1 h-3 w-3"
            :class="ui.deckMenuOpen ? 'rotate-180' : ''"
            viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"
          >
            <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 15.75l7.5-7.5 7.5 7.5" />
          </svg>
          <span
            v-if="tab.key === 'notifications' && notifStore.unreadCount > 0"
            class="absolute right-1.5 top-1.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-linear-to-r from-brand-600 to-fuchsia-600 px-1 text-[10px] font-bold text-white dark:from-brand-500 dark:to-fuchsia-500"
          >{{ notifStore.unreadCount > 99 ? '99+' : notifStore.unreadCount }}</span>
        </router-link>
        <button
          v-else
          @click="handleTab(tab)"
          class="flex h-14 w-14 touch-manipulation flex-col items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 rounded-xl"
          :aria-label="t(`nav.${tab.key}`)"
        >
          <span class="flex h-10 w-10 items-center justify-center rounded-full bg-linear-to-r from-brand-600 via-violet-600 to-fuchsia-600 text-white shadow-soft transition-all active:scale-95 dark:from-brand-500 dark:via-violet-500 dark:to-fuchsia-500" aria-hidden="true">
            <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" :d="tab.icon" />
            </svg>
          </span>
        </button>
      </li>
      <!-- More menu button -->
      <li>
        <button
          @click="ui.closeDeckMenu(); menuOpen = !menuOpen"
          class="flex h-14 w-14 touch-manipulation flex-col items-center justify-center rounded-xl transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
          :class="menuOpen ? 'text-brand-600 dark:text-brand-400' : 'text-slate-500 dark:text-slate-400'"
          :aria-label="t('nav.more') || 'More'"
        >
          <svg class="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
          </svg>
        </button>
      </li>
    </ul>
  </nav>
</template>
