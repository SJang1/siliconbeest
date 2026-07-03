<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'
import { useNotificationsStore } from '@/stores/notifications'

const { t } = useI18n()
const route = useRoute()
const auth = useAuthStore()
const ui = useUiStore()
const notifStore = useNotificationsStore()

const unreadBadge = computed(() => {
  const n = notifStore.unreadCount
  return n > 99 ? '99+' : n > 0 ? String(n) : ''
})

function isActive(path: string): boolean {
  return path === '/home' ? route.name === 'home' : route.path.startsWith(path)
}
</script>

<template>
  <nav class="dk-hairline-t flex flex-none items-center justify-around px-2 py-1.5" :aria-label="t('nav.main_navigation')">
    <router-link
      to="/home"
      class="dk-dim-text relative flex flex-col items-center gap-0.5 rounded-xl px-3 py-1 no-underline"
      :class="{ 'dk-text': isActive('/home') }"
      :aria-label="t('deck.deck')"
    >
      <span class="text-lg" aria-hidden="true">🗂️</span>
      <span class="dk-rail-label">{{ t('deck.deck') }}</span>
    </router-link>

    <router-link
      v-if="auth.isAuthenticated"
      to="/notifications"
      class="dk-dim-text relative flex flex-col items-center gap-0.5 rounded-xl px-3 py-1 no-underline"
      :class="{ 'dk-text': isActive('/notifications') }"
      :aria-label="t('nav.notifications')"
    >
      <span class="text-lg" aria-hidden="true">🔔</span>
      <span class="dk-rail-label">{{ t('deck.nav_alerts') }}</span>
      <span v-if="unreadBadge" class="dk-rail-badge">{{ unreadBadge }}</span>
    </router-link>

    <button
      v-if="auth.isAuthenticated"
      type="button"
      class="dk-btn-accent -mt-4 h-12 w-12 rounded-full !p-0 text-xl"
      :aria-label="t('deck.note')"
      @click="ui.openComposeModal()"
    >
      ＋
    </button>

    <router-link
      to="/search"
      class="dk-dim-text relative flex flex-col items-center gap-0.5 rounded-xl px-3 py-1 no-underline"
      :class="{ 'dk-text': isActive('/search') }"
      :aria-label="t('nav.search')"
    >
      <span class="text-lg" aria-hidden="true">🔭</span>
      <span class="dk-rail-label">{{ t('nav.search') }}</span>
    </router-link>

    <router-link
      v-if="auth.isAuthenticated"
      to="/settings"
      class="dk-dim-text relative flex flex-col items-center gap-0.5 rounded-xl px-3 py-1 no-underline"
      :class="{ 'dk-text': isActive('/settings') }"
      :aria-label="t('nav.settings')"
    >
      <span class="text-lg" aria-hidden="true">⚙️</span>
      <span class="dk-rail-label">{{ t('nav.settings') }}</span>
    </router-link>
    <router-link
      v-else
      to="/login"
      class="dk-dim-text relative flex flex-col items-center gap-0.5 rounded-xl px-3 py-1 no-underline"
      :aria-label="t('auth.login')"
    >
      <span class="text-lg" aria-hidden="true">🔑</span>
      <span class="dk-rail-label">{{ t('auth.login') }}</span>
    </router-link>
  </nav>
</template>
