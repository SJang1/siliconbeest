<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import AppShell from '@/components/layout/AppShell.vue'
import LanguageSelector from '@/components/settings/LanguageSelector.vue'

const { t } = useI18n()
const router = useRouter()
const auth = useAuthStore()

function signOut() {
  auth.logout()
  router.push('/login')
}

const settingSections = computed(() => {
  const sections = [
    { key: 'profile', name: 'settings-profile' },
    { key: 'account', name: 'settings-account' },
    { key: 'appearance', name: 'settings-appearance' },
    { key: 'notifications', name: 'settings-notifications' },
    { key: 'filters', name: 'settings-filters' },
    { key: 'migration', name: 'settings-migration' },
    { key: 'security', name: 'settings-security' },
  ]
  if (auth.isAdmin) {
    sections.push({ key: 'admin', name: 'admin-settings' })
  }
  return sections
})
</script>

<template>
  <AppShell>
    <div>
      <header class="sticky top-0 z-10 bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm border-b border-gray-200 dark:border-gray-700 px-4 py-3">
        <h1 class="text-xl font-bold">{{ t('nav.settings') }}</h1>
      </header>

      <div class="flex">
        <!-- Settings sidebar (desktop) -->
        <nav class="hidden md:block w-56 border-r border-gray-200 dark:border-gray-700 min-h-[calc(100vh-57px)]">
          <div class="p-3 space-y-1">
            <router-link
              v-for="section in settingSections"
              :key="section.key"
              :to="{ name: section.name }"
              class="flex items-center px-3 py-2 rounded-lg text-sm font-medium transition-colors hover:bg-gray-100 dark:hover:bg-gray-800"
              active-class="bg-gray-100 dark:bg-gray-800 font-bold"
            >
              {{ t(`settings.${section.key}`) }}
            </router-link>
          </div>

          <div class="p-3 border-t border-gray-200 dark:border-gray-700">
            <LanguageSelector />
          </div>

          <div class="p-3">
            <button @click="signOut" class="w-full py-2 rounded-lg border border-red-300 dark:border-red-700 text-red-600 dark:text-red-400 text-sm font-medium hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
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
                :to="{ name: section.name }"
                class="px-3 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-colors"
                active-class="bg-indigo-600 text-white"
              >
                {{ t(`settings.${section.key}`) }}
              </router-link>
            </div>
          </div>

          <router-view />
        </div>
      </div>
    </div>
  </AppShell>
</template>
