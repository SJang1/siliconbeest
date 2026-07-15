<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'
import { useInstanceStore } from '@/stores/instance'
import { useNotificationsStore } from '@/stores/notifications'
import { SUPPORTED_LOCALES, setDisplayLocale } from '@/i18n'
import { ref, computed, onMounted } from 'vue'
import { apiFetch } from '@/api/client'
import { stripAuroraPrefix, toOldPath } from '@/utils/designVersion'
import { withCurrentDesign } from '@/utils/safeRedirect'
import Avatar from '../common/Avatar.vue'

const { t, locale } = useI18n()
const route = useRoute()
const auth = useAuthStore()
const ui = useUiStore()
const instanceStore = useInstanceStore()
const notifStore = useNotificationsStore()

// Heroicons 24 outline path data (presentation only)
const navItems = [
  { key: 'home', path: '/home', icon: 'M2.25 12l8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25' },
  { key: 'local_timeline', path: '/explore/local', icon: 'M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z' },
  { key: 'federated_timeline', path: '/explore/public', icon: 'M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m-18.432 0A8.959 8.959 0 013 12c0-.778.099-1.533.284-2.253' },
  { key: 'notifications', path: '/notifications', icon: 'M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0' },
  { key: 'search', path: '/search', icon: 'M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z' },
  { key: 'bookmarks', path: '/bookmarks', icon: 'M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0111.186 0z' },
  { key: 'favourites', path: '/favourites', icon: 'M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z' },
  { key: 'lists', path: '/lists', icon: 'M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 010 3.75H5.625a1.875 1.875 0 010-3.75z' },
  { key: 'followed_tags', path: '/followed_tags', icon: 'M5.25 8.25h15m-16.5 7.5h15m-1.8-13.5l-3.9 19.5m-2.1-19.5l-3.9 19.5' },
  { key: 'directory', path: '/directory', icon: 'M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25' },
]

const myProfilePath = computed(() => {
  const acct = auth.currentUser?.acct || auth.currentUser?.username
  return designedPath(acct ? `/@${acct}` : '/settings/profile')
})

function designedPath(path: string): string {
  return withCurrentDesign(path, route.path)
}

const followRequestCount = ref(0)

function compose() {
  ui.openComposeModal()
}

async function checkFollowRequests() {
  if (!auth.token) return
  try {
    const { data } = await apiFetch<any[]>('/v1/follow_requests', { token: auth.token })
    followRequestCount.value = data.length
  } catch { /* ignore */ }
}

onMounted(checkFollowRequests)

async function switchLocale(code: string) {
  await setDisplayLocale(code)
}

function handleLocaleChange(event: Event) {
  const target = event.target as HTMLSelectElement
  void switchLocale(target.value)
}
</script>

<template>
  <nav class="flex flex-col h-full p-4" :aria-label="t('nav.main_navigation')">
    <!-- Logo -->
    <router-link :to="designedPath('/')" class="flex items-center gap-2 px-3 py-2 mb-4 no-underline">
      <span class="sb-heading sb-gradient-text text-2xl">{{ instanceStore.instance?.title }}</span>
    </router-link>

    <!-- Authenticated: full nav -->
    <template v-if="auth.isAuthenticated">
      <!-- Nav Links -->
      <ul class="space-y-1 flex-1">
        <li v-for="item in navItems" :key="item.key">
          <router-link
            :to="designedPath(item.path)"
            class="sb-nav-item no-underline"
            active-class="sb-nav-item-active"
          >
            <svg class="h-6 w-6 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" :d="item.icon" />
            </svg>
            <span>{{ t(`nav.${item.key}`) }}</span>
            <span
              v-if="item.key === 'notifications' && notifStore.unreadCount > 0"
              class="ml-auto flex h-5 min-w-[20px] items-center justify-center rounded-full bg-linear-to-r from-brand-600 to-fuchsia-600 px-1.5 text-xs font-bold text-white dark:from-brand-500 dark:to-fuchsia-500"
            >{{ notifStore.unreadCount > 99 ? '99+' : notifStore.unreadCount }}</span>
          </router-link>
        </li>
      </ul>

      <!-- Follow Requests -->
      <router-link
        v-if="followRequestCount > 0"
        :to="designedPath('/follow-requests')"
        class="sb-nav-item mb-1 no-underline"
        active-class="sb-nav-item-active"
      >
        <svg class="h-6 w-6 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" d="M18 7.5v3m0 0v3m0-3h3m-3 0h-3m-2.25-4.125a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zM3 19.235v-.11a6.375 6.375 0 0112.75 0v.109A12.318 12.318 0 019.374 21c-2.331 0-4.512-.645-6.374-1.766z" />
        </svg>
        <span>{{ t('nav.follow_requests') }}</span>
        <span class="ml-auto rounded-full bg-linear-to-r from-brand-600 to-fuchsia-600 px-2 py-0.5 text-xs font-bold text-white dark:from-brand-500 dark:to-fuchsia-500">{{ followRequestCount }}</span>
      </router-link>

      <!-- Settings -->
      <router-link
        :to="designedPath('/settings')"
        class="sb-nav-item mb-1 no-underline"
        active-class="sb-nav-item-active"
      >
        <svg class="h-6 w-6 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
        <span>{{ t('nav.settings') }}</span>
      </router-link>

      <!-- Admin/Moderator Link -->
      <router-link
        v-if="auth.isAdmin || auth.isModerator"
        :to="designedPath('/admin')"
        class="sb-nav-item mb-2 no-underline"
        active-class="sb-nav-item-active"
      >
        <svg class="h-6 w-6 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
        </svg>
        <span>{{ t('nav.admin') }}</span>
      </router-link>

      <!-- Compose Button -->
      <button
        @click="compose"
        class="sb-btn sb-btn-primary mb-4 mt-3 w-full py-3 text-base"
        :aria-label="t('compose.title')"
      >
        {{ t('compose.title') }}
      </button>
    </template>

    <!-- Not authenticated: login/register + public links -->
    <template v-else>
      <div class="space-y-2 flex-1">
        <router-link
          :to="designedPath('/explore/local')"
          class="sb-nav-item no-underline"
          active-class="sb-nav-item-active"
        >
          <svg class="h-6 w-6 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
          </svg>
          <span>{{ t('nav.explore') }}</span>
        </router-link>
        <router-link
          :to="designedPath('/about')"
          class="sb-nav-item no-underline"
          active-class="sb-nav-item-active"
        >
          <svg class="h-6 w-6 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
          </svg>
          <span>{{ t('nav.about') }}</span>
        </router-link>
      </div>

      <router-link
        :to="designedPath('/login')"
        class="sb-btn sb-btn-primary mb-2 w-full py-3 text-base no-underline"
      >
        {{ t('auth.login') }}
      </router-link>
      <router-link
        :to="designedPath('/register')"
        class="sb-btn sb-btn-secondary mb-4 w-full py-3 text-base no-underline"
      >
        {{ t('auth.register') }}
      </router-link>
    </template>

    <!-- Language Selector -->
    <div class="relative mb-3">
      <svg class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500 dark:text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m-18.432 0A8.959 8.959 0 013 12c0-.778.099-1.533.284-2.253" />
      </svg>
      <select
        :value="locale"
        class="w-full appearance-none rounded-xl bg-transparent py-2 pl-9 pr-8 text-sm text-slate-600 transition-colors hover:bg-surface-2 focus:bg-surface-2 focus:outline-none focus:ring-2 focus:ring-brand-400 dark:text-slate-400 dark:hover:bg-surface-2-dark dark:focus:bg-surface-2-dark"
        :aria-label="t('settings.display_language')"
        @change="handleLocaleChange"
      >
        <option
          v-for="loc in SUPPORTED_LOCALES"
          :key="loc.code"
          :value="loc.code"
        >
          {{ loc.name }}
        </option>
      </select>
      <svg class="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500 dark:text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
      </svg>
    </div>

    <!-- Current User — links to my profile (only when logged in) -->
    <router-link
      v-if="auth.isAuthenticated && auth.currentUser"
      :to="myProfilePath"
      class="flex items-center gap-3 rounded-xl p-2.5 no-underline transition-colors hover:bg-surface-2 dark:hover:bg-surface-2-dark"
    >
      <span class="sb-avatar-ring flex shrink-0">
        <Avatar :src="auth.currentUser.avatar ?? ''" :alt="auth.currentUser.display_name ?? 'User'" size="sm" />
      </span>
      <div class="flex-1 min-w-0">
        <p class="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">{{ auth.currentUser.display_name ?? t('nav.profile') }}</p>
        <p class="truncate text-xs text-slate-500 dark:text-slate-400">@{{ auth.currentUser.username ?? 'user' }}</p>
      </div>
    </router-link>

    <!-- Back to classic design -->
    <a
      :href="toOldPath(stripAuroraPrefix(route.fullPath))"
      class="mt-2 block px-3 py-1.5 text-center text-xs text-slate-400 no-underline transition-colors hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300"
    >
      {{ t('design.backToClassic') }}
    </a>
  </nav>
</template>
