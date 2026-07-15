<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { withCurrentDesign } from '@/utils/safeRedirect'
import DeckPageShell from '@/deck/layout/DeckPageShell.vue'
import LanguageSelector from '@/components/settings/LanguageSelector.vue'

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
  <DeckPageShell>
    <div>
      <header class="sb-glass sticky top-0 z-10 border-b px-4 py-3">
        <h1 class="sb-heading text-lg">{{ t('nav.settings') }}</h1>
      </header>

      <div class="flex">
        <!-- Settings sidebar (desktop) -->
        <nav class="hidden md:flex md:flex-col md:justify-between w-60 xl:w-64 border-r border-outline dark:border-outline-dark min-h-[calc(100vh-57px)] flex-shrink-0">
          <div class="p-4 space-y-1">
            <router-link
              v-for="section in settingSections"
              :key="section.key"
              :to="sectionPath(section.path)"
              class="sb-nav-item"
              active-class="sb-nav-item-active"
            >
              {{ t(`settings.${section.key}`) }}
            </router-link>
          </div>

          <div class="p-4 space-y-3 border-t border-outline dark:border-outline-dark">
            <LanguageSelector />
            <button @click="signOut" class="sb-btn w-full border border-red-200 text-red-600 hover:bg-red-50 dark:border-red-900/60 dark:text-red-400 dark:hover:bg-red-950/40">
              {{ t('settings.sign_out') }}
            </button>
          </div>
        </nav>

        <!-- Settings content -->
        <div class="flex-1 min-w-0">
          <!-- Mobile nav -->
          <div class="md:hidden p-3 border-b border-outline dark:border-outline-dark overflow-x-auto">
            <div class="flex gap-2">
              <router-link
                v-for="section in settingSections"
                :key="section.key"
                :to="sectionPath(section.path)"
                class="px-3.5 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-colors text-slate-600 hover:bg-surface-2 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-surface-2-dark dark:hover:text-white"
                active-class="!bg-brand-600 !text-white !font-semibold dark:!bg-brand-500"
              >
                {{ t(`settings.${section.key}`) }}
              </router-link>
            </div>
          </div>

          <!-- Content area with proper padding and max-width -->
          <div class="p-5 md:p-8 lg:p-10 w-full max-w-3xl animate-fade-in">
            <router-view />
          </div>
        </div>
      </div>
    </div>
  </DeckPageShell>
</template>
