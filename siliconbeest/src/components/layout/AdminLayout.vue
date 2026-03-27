<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import AppShell from './AppShell.vue'

const { t } = useI18n()
const route = useRoute()
const auth = useAuthStore()
const sidebarOpen = ref(false)

const allNavItems = [
  { key: 'dashboard', path: '/admin', icon: '📊', adminOnly: false },
  { key: 'accounts', path: '/admin/accounts', icon: '👥', adminOnly: false },
  { key: 'reports', path: '/admin/reports', icon: '🚩', adminOnly: false },
  { key: 'domain_blocks', path: '/admin/domain-blocks', icon: '🚫', adminOnly: true },
  { key: 'settings', path: '/admin/settings', icon: '⚙️', adminOnly: true },
  { key: 'announcements', path: '/admin/announcements', icon: '📢', adminOnly: false },
  { key: 'rules', path: '/admin/rules', icon: '📜', adminOnly: true },
  { key: 'relays', path: '/admin/relays', icon: '🔗', adminOnly: true },
  { key: 'custom_emojis', path: '/admin/custom-emojis', icon: '😀', adminOnly: true },
  { key: 'federation', path: '/admin/federation', icon: '🌐', adminOnly: true },
]

const navItems = computed(() =>
  auth.isAdmin ? allNavItems : allNavItems.filter(item => !item.adminOnly)
)

function isActive(path: string): boolean {
  if (path === '/admin') {
    return route.path === '/admin'
  }
  return route.path.startsWith(path)
}

function toggleSidebar() {
  sidebarOpen.value = !sidebarOpen.value
}

function closeSidebar() {
  sidebarOpen.value = false
}
</script>

<template>
  <AppShell>
    <div class="flex min-h-screen">
      <!-- Mobile top bar with hamburger -->
      <div class="lg:hidden fixed top-0 left-0 right-0 z-30 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 px-4 py-3 flex items-center gap-3">
        <button
          @click="toggleSidebar"
          class="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          :aria-label="t('admin.title')"
        >
          <svg class="w-6 h-6 text-gray-600 dark:text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <span class="font-semibold text-gray-900 dark:text-white">{{ t('admin.title') }}</span>
      </div>

      <!-- Mobile overlay -->
      <div
        v-if="sidebarOpen"
        class="lg:hidden fixed inset-0 z-40 bg-black/50"
        @click="closeSidebar"
      />

      <!-- Admin sidebar -->
      <aside
        class="fixed lg:sticky top-0 left-0 z-50 lg:z-auto h-screen w-64 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700 transform transition-transform duration-200 ease-in-out lg:translate-x-0 overflow-y-auto"
        :class="sidebarOpen ? 'translate-x-0' : '-translate-x-full'"
      >
        <div class="p-4">
          <!-- Close button for mobile -->
          <div class="flex items-center justify-between lg:hidden mb-4">
            <span class="font-semibold text-gray-900 dark:text-white">{{ t('admin.title') }}</span>
            <button
              @click="closeSidebar"
              class="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            >
              <svg class="w-5 h-5 text-gray-500 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <!-- Desktop title -->
          <h2 class="hidden lg:block text-lg font-bold text-gray-900 dark:text-white mb-4 px-3">
            {{ t('admin.title') }}
          </h2>

          <!-- Nav links -->
          <nav>
            <ul class="space-y-1">
              <li v-for="item in navItems" :key="item.key">
                <router-link
                  :to="item.path"
                  class="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors no-underline"
                  :class="
                    isActive(item.path)
                      ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 font-semibold'
                      : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
                  "
                  @click="closeSidebar"
                >
                  <span class="text-lg w-6 text-center" aria-hidden="true">{{ item.icon }}</span>
                  <span>{{ t(`admin.nav.${item.key}`) }}</span>
                </router-link>
              </li>
            </ul>
          </nav>
        </div>
      </aside>

      <!-- Main content area -->
      <div class="flex-1 min-w-0 pt-14 lg:pt-0">
        <div class="p-4 lg:p-6">
          <slot />
        </div>
      </div>
    </div>
  </AppShell>
</template>
