<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useUiStore } from '@/stores/ui'
import Sidebar from './Sidebar.vue'
import MobileNav from './MobileNav.vue'

const { t } = useI18n()
const ui = useUiStore()

const props = withDefaults(defineProps<{
  containedMain?: boolean
}>(), {
  containedMain: false,
})

const gridClass = computed(() =>
  ui.showTrending
    ? 'grid-cols-1 md:grid-cols-[16rem_1fr] lg:grid-cols-[16rem_1fr_20rem] xl:grid-cols-[18rem_1fr_20rem]'
    : 'grid-cols-1 md:grid-cols-[16rem_1fr] xl:grid-cols-[18rem_1fr]'
)

const mainClass = computed(() => [
  'overflow-x-hidden border-r border-outline dark:border-outline-dark w-full',
  props.containedMain
    ? 'h-[calc(100dvh-4.75rem)] md:h-dvh overflow-hidden'
    : 'min-h-dvh pb-24 md:pb-0',
])
</script>

<template>
  <div class="sb-app min-h-dvh">
    <div class="grid min-h-dvh" :class="gridClass">
      <!-- Desktop Sidebar — pinned to left edge -->
      <aside class="hidden md:flex md:flex-col md:sticky md:top-0 md:h-dvh overflow-y-auto border-r border-outline bg-surface/60 dark:border-outline-dark dark:bg-surface-dark/40">
        <Sidebar />
      </aside>

      <!-- Main Content -->
      <main
        :class="mainClass"
      >
        <slot />
      </main>

      <!-- Right Panel (trending) — pinned to right edge -->
      <aside v-if="ui.showTrending" class="hidden lg:block lg:sticky lg:top-0 lg:h-dvh overflow-y-auto p-4">
        <slot name="right-panel">
          <div class="sb-card p-5">
            <h2 class="sb-heading mb-3 text-lg text-slate-900 dark:text-slate-100">{{ t('explore.trending') }}</h2>
            <p class="text-sm text-slate-500 dark:text-slate-400">{{ t('explore.empty') }}</p>
          </div>
        </slot>
      </aside>
    </div>

    <!-- Mobile Bottom Nav -->
    <MobileNav />
  </div>
</template>
