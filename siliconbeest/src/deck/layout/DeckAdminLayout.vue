<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { withCurrentDesign } from '@/utils/safeRedirect'
import DeckPageShell from './DeckPageShell.vue'

const { t } = useI18n()
const route = useRoute()
const auth = useAuthStore()
const sidebarOpen = ref(false)

// Heroicons 24 outline path data (presentation only)
const allNavItems = [
  { key: 'dashboard', path: '/admin', icon: 'M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z', adminOnly: false },
  { key: 'accounts', path: '/admin/accounts', icon: 'M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z', adminOnly: false },
  { key: 'reports', path: '/admin/reports', icon: 'M3 3v1.5M3 21v-6m0 0l2.77-.693a9 9 0 016.208.682l.108.054a9 9 0 006.086.71l3.114-.732a48.524 48.524 0 01-.005-10.499l-3.11.732a9 9 0 01-6.085-.711l-.108-.054a9 9 0 00-6.208-.682L3 4.5M3 15V4.5', adminOnly: false },
  { key: 'domain_blocks', path: '/admin/domain-blocks', icon: 'M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636', adminOnly: true },
  { key: 'settings', path: '/admin/settings', icon: 'M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z M15 12a3 3 0 11-6 0 3 3 0 016 0z', adminOnly: true },
  { key: 'invitation_credits', path: '/admin/invitation-credits', icon: 'M15.75 5.25a3 3 0 11-6 0 3 3 0 016 0z M4.5 21a7.5 7.5 0 0115 0', adminOnly: true },
  { key: 'invitation_audit_logs', path: '/admin/invitation-audit-logs', icon: 'M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5 M8.25 12.75h7.5m-7.5 3H12', adminOnly: true },
  { key: 'announcements', path: '/admin/announcements', icon: 'M10.34 15.84c-.688-.06-1.386-.09-2.09-.09H7.5a4.5 4.5 0 110-9h.75c.704 0 1.402-.03 2.09-.09m0 9.18c.253.962.584 1.892.985 2.783.247.55.06 1.21-.463 1.511l-.657.38c-.551.318-1.26.117-1.527-.461a20.845 20.845 0 01-1.44-4.282m3.102.069a18.03 18.03 0 01-.59-4.59c0-1.586.205-3.124.59-4.59m0 9.18a23.848 23.848 0 018.835 2.535M10.34 6.66a23.847 23.847 0 008.835-2.535m0 0A23.74 23.74 0 0018.795 3m.38 1.125a23.91 23.91 0 011.014 5.395m-1.014 8.855c-.118.38-.245.754-.38 1.125m.38-1.125a23.91 23.91 0 001.014-5.395m0-3.46c.495.413.811 1.035.811 1.73 0 .695-.316 1.317-.811 1.73m0-3.46a24.347 24.347 0 010 3.46', adminOnly: false },
  { key: 'rules', path: '/admin/rules', icon: 'M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z', adminOnly: true },
  { key: 'relays', path: '/admin/relays', icon: 'M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244', adminOnly: true },
  { key: 'custom_emojis', path: '/admin/custom-emojis', icon: 'M15.182 15.182a4.5 4.5 0 01-6.364 0M21 12a9 9 0 11-18 0 9 9 0 0118 0zM9.75 9.75c0 .414-.168.75-.375.75S9 10.164 9 9.75 9.168 9 9.375 9s.375.336.375.75zm-.375 0h.008v.015h-.008V9.75zm5.625 0c0 .414-.168.75-.375.75s-.375-.336-.375-.75.168-.75.375-.75.375.336.375.75zm-.375 0h.008v.015h-.008V9.75z', adminOnly: true },
  { key: 'federation', path: '/admin/federation', icon: 'M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m-18.432 0A8.959 8.959 0 013 12c0-.778.099-1.533.284-2.253', adminOnly: true },
]

const navItems = computed(() =>
  auth.isAdmin ? allNavItems : allNavItems.filter(item => !item.adminOnly)
)

function designedPath(path: string): string {
  return withCurrentDesign(path, route.path)
}

function isActive(path: string): boolean {
  const target = designedPath(path)
  if (path === '/admin') {
    return route.path === target
  }
  return route.path.startsWith(target)
}

function toggleSidebar() {
  sidebarOpen.value = !sidebarOpen.value
}

function closeSidebar() {
  sidebarOpen.value = false
}
</script>

<template>
  <DeckPageShell width="full">
    <div class="flex min-h-full">
      <!-- Mobile top bar with hamburger -->
      <div class="sb-glass lg:hidden fixed top-0 left-0 right-0 z-30 border-b px-4 py-3 flex items-center gap-3">
        <button
          @click="toggleSidebar"
          class="rounded-xl p-1.5 text-slate-600 transition-colors hover:bg-surface-2 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 dark:text-slate-300 dark:hover:bg-surface-2-dark dark:hover:text-white"
          :aria-label="t('admin.title')"
        >
          <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
          </svg>
        </button>
        <span class="sb-heading text-base text-slate-900 dark:text-white">{{ t('admin.title') }}</span>
      </div>

      <!-- Mobile overlay -->
      <div
        v-if="sidebarOpen"
        class="lg:hidden fixed inset-0 z-40 bg-slate-950/50 backdrop-blur-sm"
        @click="closeSidebar"
      />

      <!-- Admin sidebar -->
      <aside
        class="fixed lg:sticky top-0 left-0 z-50 lg:z-auto h-screen w-64 border-r border-outline bg-surface shadow-lift dark:border-outline-dark dark:bg-surface-dark lg:shadow-none transform transition-transform duration-200 ease-in-out lg:translate-x-0 overflow-y-auto"
        :class="sidebarOpen ? 'translate-x-0' : '-translate-x-full'"
      >
        <div class="p-4">
          <!-- Close button for mobile -->
          <div class="flex items-center justify-between lg:hidden mb-4">
            <span class="sb-heading text-base text-slate-900 dark:text-white">{{ t('admin.title') }}</span>
            <button
              @click="closeSidebar"
              class="rounded-xl p-1.5 text-slate-500 transition-colors hover:bg-surface-2 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 dark:text-slate-400 dark:hover:bg-surface-2-dark dark:hover:text-white"
            >
              <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <!-- Desktop title -->
          <h2 class="hidden lg:block sb-heading text-lg text-slate-900 dark:text-white mb-4 px-3">
            {{ t('admin.title') }}
          </h2>

          <!-- Nav links -->
          <nav>
            <ul class="space-y-1">
              <li v-for="item in navItems" :key="item.key">
                <router-link
                  :to="designedPath(item.path)"
                  class="sb-nav-item no-underline"
                  :class="isActive(item.path) ? 'sb-nav-item-active' : ''"
                  @click="closeSidebar"
                >
                  <svg class="h-5 w-5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                    <path stroke-linecap="round" stroke-linejoin="round" :d="item.icon" />
                  </svg>
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
  </DeckPageShell>
</template>
