<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'
import { useInstanceStore } from '@/stores/instance'
import { useNotificationsStore } from '@/stores/notifications'
import { SUPPORTED_LOCALES, setDisplayLocale } from '@/i18n'
import { ref, computed, onMounted } from 'vue'
import { apiFetch } from '@/api/client'
import Avatar from '../common/Avatar.vue'

const { t, locale } = useI18n()
const router = useRouter()
const auth = useAuthStore()
const ui = useUiStore()
const instanceStore = useInstanceStore()
const notifStore = useNotificationsStore()

const navItems = [
  { key: 'home', path: '/home', icon: '🏠' },
  { key: 'local_timeline', path: '/explore/local', icon: '👥' },
  { key: 'federated_timeline', path: '/explore/public', icon: '🌐' },
  { key: 'notifications', path: '/notifications', icon: '🔔' },
  { key: 'search', path: '/search', icon: '🔎' },
  { key: 'bookmarks', path: '/bookmarks', icon: '🔖' },
  { key: 'favourites', path: '/favourites', icon: '⭐' },
  { key: 'lists', path: '/lists', icon: '📋' },
  { key: 'followed_tags', path: '/followed_tags', icon: '#️⃣' },
  { key: 'directory', path: '/directory', icon: '📖' },
]

const myProfilePath = computed(() => {
  const acct = auth.currentUser?.acct || auth.currentUser?.username
  return acct ? `/@${acct}` : '/settings/profile'
})

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
  <nav class="flex flex-col h-full p-4" aria-label="Main navigation">
    <!-- Logo -->
    <router-link to="/" class="flex items-center gap-2 px-3 py-2 mb-4 no-underline">
      <span class="text-2xl font-bold text-indigo-600 dark:text-indigo-400">{{ instanceStore.instance?.title }}</span>
    </router-link>

    <!-- Authenticated: full nav -->
    <template v-if="auth.isAuthenticated">
      <!-- Nav Links -->
      <ul class="space-y-1 flex-1">
        <li v-for="item in navItems" :key="item.key">
          <router-link
            :to="item.path"
            class="flex items-center gap-3 px-3 py-2.5 rounded-lg text-lg font-medium transition-colors hover:bg-gray-100 dark:hover:bg-gray-800 no-underline text-gray-900 dark:text-gray-100"
            active-class="bg-gray-100 dark:bg-gray-800 font-bold"
          >
            <span class="text-xl w-7 text-center" aria-hidden="true">{{ item.icon }}</span>
            <span>{{ t(`nav.${item.key}`) }}</span>
            <span
              v-if="item.key === 'notifications' && notifStore.unreadCount > 0"
              class="ml-auto bg-red-500 text-white text-xs font-bold min-w-[20px] h-5 flex items-center justify-center px-1.5 rounded-full"
            >{{ notifStore.unreadCount > 99 ? '99+' : notifStore.unreadCount }}</span>
          </router-link>
        </li>
      </ul>

      <!-- Follow Requests -->
      <router-link
        v-if="followRequestCount > 0"
        to="/follow-requests"
        class="flex items-center gap-3 px-3 py-2.5 mb-1 rounded-lg text-lg font-medium transition-colors hover:bg-gray-100 dark:hover:bg-gray-800 no-underline text-gray-900 dark:text-gray-100"
        active-class="bg-gray-100 dark:bg-gray-800 font-bold"
      >
        <span class="text-xl w-7 text-center" aria-hidden="true">👋</span>
        <span>{{ t('nav.follow_requests') }}</span>
        <span class="ml-auto bg-indigo-600 text-white text-xs font-bold px-2 py-0.5 rounded-full">{{ followRequestCount }}</span>
      </router-link>

      <!-- Settings -->
      <router-link
        to="/settings"
        class="flex items-center gap-3 px-3 py-2.5 mb-1 rounded-lg text-lg font-medium transition-colors hover:bg-gray-100 dark:hover:bg-gray-800 no-underline text-gray-900 dark:text-gray-100"
        active-class="bg-gray-100 dark:bg-gray-800 font-bold"
      >
        <span class="text-xl w-7 text-center" aria-hidden="true">⚙️</span>
        <span>{{ t('nav.settings') }}</span>
      </router-link>

      <!-- Admin/Moderator Link -->
      <router-link
        v-if="auth.isAdmin || auth.isModerator"
        to="/admin"
        class="flex items-center gap-3 px-3 py-2.5 mb-2 rounded-lg text-lg font-medium transition-colors hover:bg-gray-100 dark:hover:bg-gray-800 no-underline text-gray-900 dark:text-gray-100"
        active-class="bg-gray-100 dark:bg-gray-800 font-bold"
      >
        <span class="text-xl w-7 text-center" aria-hidden="true">🛡️</span>
        <span>{{ t('nav.admin') }}</span>
      </router-link>

      <!-- Compose Button -->
      <button
        @click="compose"
        class="w-full py-3 px-4 mb-4 rounded-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-lg transition-colors"
        :aria-label="t('compose.title')"
      >
        {{ t('compose.title') }}
      </button>
    </template>

    <!-- Not authenticated: login/register + public links -->
    <template v-else>
      <div class="space-y-2 flex-1">
        <router-link
          to="/explore/local"
          class="flex items-center gap-3 px-3 py-2.5 rounded-lg text-lg font-medium transition-colors hover:bg-gray-100 dark:hover:bg-gray-800 no-underline text-gray-900 dark:text-gray-100"
          active-class="bg-gray-100 dark:bg-gray-800 font-bold"
        >
          <span class="text-xl w-7 text-center" aria-hidden="true">🔍</span>
          <span>{{ t('nav.explore') }}</span>
        </router-link>
        <router-link
          to="/about"
          class="flex items-center gap-3 px-3 py-2.5 rounded-lg text-lg font-medium transition-colors hover:bg-gray-100 dark:hover:bg-gray-800 no-underline text-gray-900 dark:text-gray-100"
          active-class="bg-gray-100 dark:bg-gray-800 font-bold"
        >
          <span class="text-xl w-7 text-center" aria-hidden="true">ℹ️</span>
          <span>{{ t('nav.about') }}</span>
        </router-link>
      </div>

      <router-link
        to="/login"
        class="w-full py-3 px-4 mb-2 rounded-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-lg transition-colors text-center block no-underline"
      >
        {{ t('auth.login') }}
      </router-link>
      <router-link
        to="/register"
        class="w-full py-3 px-4 mb-4 rounded-full border-2 border-indigo-600 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 font-bold text-lg transition-colors text-center block no-underline"
      >
        {{ t('auth.register') }}
      </router-link>
    </template>

    <!-- Language Selector -->
    <div class="relative mb-3">
      <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm" aria-hidden="true">🌐</span>
      <select
        :value="locale"
        class="w-full appearance-none rounded-lg bg-transparent py-2 pl-9 pr-8 text-sm text-gray-600 transition-colors hover:bg-gray-100 focus:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:text-gray-400 dark:hover:bg-gray-800 dark:focus:bg-gray-800"
        aria-label="Display language"
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
      <span class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-500" aria-hidden="true">▾</span>
    </div>

    <!-- Current User — links to my profile (only when logged in) -->
    <router-link
      v-if="auth.isAuthenticated && auth.currentUser"
      :to="myProfilePath"
      class="flex items-center gap-3 p-3 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 no-underline text-gray-900 dark:text-gray-100"
    >
      <Avatar :src="auth.currentUser.avatar ?? ''" :alt="auth.currentUser.display_name ?? 'User'" size="sm" />
      <div class="flex-1 min-w-0">
        <p class="font-semibold text-sm truncate">{{ auth.currentUser.display_name ?? t('nav.profile') }}</p>
        <p class="text-xs text-gray-500 dark:text-gray-400 truncate">@{{ auth.currentUser.username ?? 'user' }}</p>
      </div>
    </router-link>
  </nav>
</template>
