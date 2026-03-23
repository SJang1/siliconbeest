<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'

const { t } = useI18n()
const auth = useAuthStore()
const ui = useUiStore()
const router = useRouter()

const menuOpen = ref(false)

const profilePath = computed(() => {
  const acct = auth.currentUser?.acct
  return acct ? `/@${acct}` : '/settings'
})

const tabs = computed(() => [
  { key: 'home', path: '/home', icon: '🏠', action: null },
  { key: 'explore', path: '/explore', icon: '🔍', action: null },
  { key: 'compose', path: null, icon: '➕', action: () => ui.openComposeModal() },
  { key: 'notifications', path: '/notifications', icon: '🔔', action: null },
  { key: 'profile', path: profilePath.value, icon: '👤', action: null },
])

function handleTab(tab: { path: string | null; action: (() => void) | null }) {
  if (tab.action) {
    tab.action()
  }
}

function navigateTo(path: string) {
  menuOpen.value = false
  router.push(path)
}

function signOut() {
  menuOpen.value = false
  auth.logout()
  router.push('/login')
}
</script>

<template>
  <!-- Slide-up menu overlay -->
  <Teleport to="body">
    <Transition name="fade">
      <div
        v-if="menuOpen"
        class="fixed inset-0 bg-black/40 z-[60]"
        @click="menuOpen = false"
      />
    </Transition>
    <Transition name="slide-up">
      <div
        v-if="menuOpen"
        class="fixed bottom-14 left-0 right-0 bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 rounded-t-2xl z-[61] shadow-2xl"
      >
        <div class="p-2 space-y-0.5">
          <!-- User info -->
          <div v-if="auth.currentUser" class="px-4 py-3 border-b border-gray-100 dark:border-gray-700 mb-1">
            <p class="font-semibold text-gray-900 dark:text-white">{{ auth.currentUser.display_name || auth.currentUser.username }}</p>
            <p class="text-sm text-gray-500 dark:text-gray-400">@{{ auth.currentUser.acct }}</p>
          </div>

          <button @click="navigateTo(profilePath)" class="flex items-center gap-3 w-full px-4 py-3 rounded-lg text-left text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
            <span class="text-lg">👤</span>
            <span>{{ t('nav.profile') }}</span>
          </button>
          <button @click="navigateTo('/search')" class="flex items-center gap-3 w-full px-4 py-3 rounded-lg text-left text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
            <span class="text-lg">🔎</span>
            <span>{{ t('nav.search') }}</span>
          </button>
          <button @click="navigateTo('/bookmarks')" class="flex items-center gap-3 w-full px-4 py-3 rounded-lg text-left text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
            <span class="text-lg">🔖</span>
            <span>{{ t('nav.bookmarks') }}</span>
          </button>
          <button @click="navigateTo('/favourites')" class="flex items-center gap-3 w-full px-4 py-3 rounded-lg text-left text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
            <span class="text-lg">⭐</span>
            <span>{{ t('nav.favourites') }}</span>
          </button>
          <button @click="navigateTo('/lists')" class="flex items-center gap-3 w-full px-4 py-3 rounded-lg text-left text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
            <span class="text-lg">📋</span>
            <span>{{ t('nav.lists') }}</span>
          </button>
          <button @click="navigateTo('/settings')" class="flex items-center gap-3 w-full px-4 py-3 rounded-lg text-left text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
            <span class="text-lg">⚙️</span>
            <span>{{ t('nav.settings') }}</span>
          </button>
          <button @click="navigateTo('/about')" class="flex items-center gap-3 w-full px-4 py-3 rounded-lg text-left text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
            <span class="text-lg">ℹ️</span>
            <span>{{ t('nav.about') }}</span>
          </button>
          <button v-if="auth.isAdmin || auth.isModerator" @click="navigateTo('/admin')" class="flex items-center gap-3 w-full px-4 py-3 rounded-lg text-left text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
            <span class="text-lg">🛡️</span>
            <span>{{ t('nav.admin') }}</span>
          </button>

          <div class="border-t border-gray-100 dark:border-gray-700 mt-1 pt-1">
            <button @click="signOut" class="flex items-center gap-3 w-full px-4 py-3 rounded-lg text-left text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
              <span class="text-lg">🚪</span>
              <span>{{ t('settings.sign_out') }}</span>
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>

  <!-- Bottom tab bar -->
  <nav
    class="fixed bottom-0 left-0 right-0 bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700 z-50 lg:hidden"
    aria-label="Mobile navigation"
  >
    <ul class="flex justify-around items-center h-14">
      <li v-for="tab in tabs" :key="tab.key">
        <router-link
          v-if="tab.path"
          :to="tab.path"
          class="flex flex-col items-center justify-center w-14 h-14 text-gray-500 dark:text-gray-400 transition-colors"
          active-class="text-indigo-600 dark:text-indigo-400"
          :aria-label="t(`nav.${tab.key}`)"
        >
          <span class="text-xl" aria-hidden="true">{{ tab.icon }}</span>
        </router-link>
        <button
          v-else
          @click="handleTab(tab)"
          class="flex flex-col items-center justify-center w-14 h-14 text-gray-500 dark:text-gray-400 transition-colors"
          :aria-label="t(`nav.${tab.key}`)"
        >
          <span class="text-xl" aria-hidden="true">{{ tab.icon }}</span>
        </button>
      </li>
      <!-- More menu button -->
      <li>
        <button
          @click="menuOpen = !menuOpen"
          class="flex flex-col items-center justify-center w-14 h-14 text-gray-500 dark:text-gray-400 transition-colors"
          :class="menuOpen ? 'text-indigo-600 dark:text-indigo-400' : ''"
          :aria-label="t('nav.more') || 'More'"
        >
          <span class="text-xl" aria-hidden="true">☰</span>
        </button>
      </li>
    </ul>
  </nav>
</template>

<style scoped>
.fade-enter-active, .fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from, .fade-leave-to {
  opacity: 0;
}
.slide-up-enter-active, .slide-up-leave-active {
  transition: transform 0.25s ease;
}
.slide-up-enter-from, .slide-up-leave-to {
  transform: translateY(100%);
}
</style>
