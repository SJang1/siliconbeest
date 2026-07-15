<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { withCurrentDesign } from '@/utils/safeRedirect'
import AppShell from '@/legacy/components/layout/AppShell.vue'
import LanguageSelector from '@/legacy/components/settings/LanguageSelector.vue'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

async function signOut() {
  await auth.logout()
  await router.push(withCurrentDesign('/login', route.path))
}

const settingSections = computed(() => {
  const sections = [
    { key: 'profile', path: '/settings/profile' },
    { key: 'account', path: '/settings/account' },
    { key: 'appearance', path: '/settings/appearance' },
    { key: 'posting', path: '/settings/posting' },
    { key: 'notifications', path: '/settings/notifications' },
    { key: 'filters', path: '/settings/filters' },
    { key: 'migration', path: '/settings/migration' },
    { key: 'security', path: '/settings/security' },
    { key: 'invitations', path: '/settings/invitations' },
  ]
  if (auth.isAdmin) {
    sections.push({ key: 'admin', path: '/admin/settings' })
  }
  return sections
})

function sectionPath(path: string): string {
  return withCurrentDesign(path, route.path)
}
</script>

<template>
  <AppShell>
    <div>
      <header class="sticky top-0 z-10 bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm border-b border-gray-200 dark:border-gray-700 px-4 py-3">
        <h1 class="text-xl font-bold">{{ t('nav.settings') }}</h1>
      </header>

      <div class="flex">
        <!-- Settings sidebar (desktop) -->
        <nav class="hidden md:flex md:flex-col md:justify-between w-60 xl:w-64 border-r border-gray-200 dark:border-gray-700 min-h-[calc(100vh-57px)] flex-shrink-0">
          <div class="p-4 space-y-1">
            <router-link
              v-for="section in settingSections"
              :key="section.key"
              :to="sectionPath(section.path)"
              class="flex items-center px-4 py-2.5 rounded-lg text-sm font-medium transition-colors hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300"
              active-class="!bg-indigo-50 dark:!bg-indigo-900/20 !text-indigo-600 dark:!text-indigo-400 !font-bold"
            >
              {{ t(`settings.${section.key}`) }}
            </router-link>
          </div>

          <div class="p-4 space-y-3 border-t border-gray-200 dark:border-gray-700">
            <LanguageSelector />
            <button @click="signOut" class="w-full py-2.5 rounded-lg border border-red-300 dark:border-red-700 text-red-600 dark:text-red-400 text-sm font-medium hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
              {{ t('settings.sign_out') }}
            </button>
          </div>
        </nav>

        <!-- Settings content -->
        <div class="flex-1 min-w-0">
          <!-- Mobile nav -->
          <div class="md:hidden p-3 border-b border-gray-200 dark:border-gray-700 overflow-x-auto">
            <div class="flex gap-2">
              <router-link
                v-for="section in settingSections"
                :key="section.key"
                :to="sectionPath(section.path)"
                class="px-3 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-colors text-gray-600 dark:text-gray-400"
                active-class="!bg-indigo-600 !text-white"
              >
                {{ t(`settings.${section.key}`) }}
              </router-link>
            </div>
          </div>

          <!-- Content area with proper padding and max-width -->
          <div class="p-5 md:p-8 lg:p-10 max-w-3xl">
            <router-view />
          </div>
        </div>
      </div>
    </div>
  </AppShell>
</template>
