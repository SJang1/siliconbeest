<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import Sidebar from './Sidebar.vue'
import MobileNav from './MobileNav.vue'

const { t } = useI18n()
</script>

<template>
  <div class="min-h-screen bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100">
    <div class="mx-auto max-w-7xl flex">
      <!-- Desktop Sidebar -->
      <aside class="hidden lg:flex lg:flex-col lg:w-64 xl:w-72 h-screen sticky top-0 border-r border-gray-200 dark:border-gray-700">
        <Sidebar />
      </aside>

      <!-- Main Content -->
      <main class="flex-1 min-h-screen border-r border-gray-200 dark:border-gray-700 max-w-2xl w-full pb-16 lg:pb-0">
        <slot />
      </main>

      <!-- Right Panel (desktop) -->
      <aside class="hidden xl:block xl:w-80 h-screen sticky top-0 p-4">
        <slot name="right-panel">
          <div class="rounded-xl bg-gray-50 dark:bg-gray-800 p-4">
            <h2 class="font-bold text-lg mb-3">{{ t('explore.trending') }}</h2>
            <p class="text-sm text-gray-500 dark:text-gray-400">{{ t('explore.empty') }}</p>
          </div>
        </slot>
      </aside>
    </div>

    <!-- Mobile Bottom Nav -->
    <MobileNav class="lg:hidden" />
  </div>
</template>
