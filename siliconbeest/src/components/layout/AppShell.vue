<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useUiStore } from '@/stores/ui'
import Sidebar from './Sidebar.vue'
import MobileNav from './MobileNav.vue'

const { t } = useI18n()
const ui = useUiStore()

const gridClass = computed(() =>
  ui.showTrending
    ? 'grid-cols-1 md:grid-cols-[16rem_1fr] lg:grid-cols-[16rem_1fr_20rem] xl:grid-cols-[18rem_1fr_20rem]'
    : 'grid-cols-1 md:grid-cols-[16rem_1fr] xl:grid-cols-[18rem_1fr]'
)
</script>

<template>
  <div class="min-h-screen bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100">
    <div class="grid min-h-screen" :class="gridClass">
      <!-- Desktop Sidebar — pinned to left edge -->
      <aside class="hidden md:flex md:flex-col h-screen sticky top-0 border-r border-gray-200 dark:border-gray-700">
        <Sidebar />
      </aside>

      <!-- Main Content -->
      <main class="min-h-screen border-r border-gray-200 dark:border-gray-700 w-full pb-16 md:pb-0">
        <slot />
      </main>

      <!-- Right Panel (trending) — pinned to right edge -->
      <aside v-if="ui.showTrending" class="hidden lg:block h-screen sticky top-0 p-4">
        <slot name="right-panel">
          <div class="rounded-xl bg-gray-50 dark:bg-gray-800 p-4">
            <h2 class="font-bold text-lg mb-3">{{ t('explore.trending') }}</h2>
            <p class="text-sm text-gray-500 dark:text-gray-400">{{ t('explore.empty') }}</p>
          </div>
        </slot>
      </aside>
    </div>

    <!-- Mobile Bottom Nav -->
    <MobileNav class="md:hidden" />
  </div>
</template>
