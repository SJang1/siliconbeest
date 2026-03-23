<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Status } from '@/types/mastodon'
import AppShell from '@/components/layout/AppShell.vue'
import TimelineFeed from '@/components/timeline/TimelineFeed.vue'

const { t } = useI18n()

type TimelineType = 'local' | 'federated'
const activeTab = ref<TimelineType>('local')
const statuses = ref<Status[]>([])
const loading = ref(false)
const done = ref(false)

async function loadTimeline() {
  if (loading.value || done.value) return
  loading.value = true
  try {
    // TODO: fetch from API based on activeTab
  } finally {
    loading.value = false
  }
}

function switchTab(tab: TimelineType) {
  activeTab.value = tab
  statuses.value = []
  done.value = false
  loadTimeline()
}

onMounted(loadTimeline)
</script>

<template>
  <AppShell>
    <div>
      <header class="sticky top-0 z-10 bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm border-b border-gray-200 dark:border-gray-700">
        <h1 class="text-xl font-bold px-4 py-3">{{ t('nav.explore') }}</h1>
        <div class="flex border-b border-gray-200 dark:border-gray-700">
          <button
            v-for="tab in (['local', 'federated'] as TimelineType[])"
            :key="tab"
            @click="switchTab(tab)"
            class="flex-1 py-3 text-center text-sm font-medium transition-colors relative"
            :class="activeTab === tab
              ? 'text-indigo-600 dark:text-indigo-400'
              : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'"
          >
            {{ t(`explore.${tab}`) }}
            <div
              v-if="activeTab === tab"
              class="absolute bottom-0 left-1/4 right-1/4 h-1 bg-indigo-600 dark:bg-indigo-400 rounded-full"
            />
          </button>
        </div>
      </header>

      <TimelineFeed
        :statuses="statuses"
        :loading="loading"
        :done="done"
        @load-more="loadTimeline"
      />
    </div>
  </AppShell>
</template>
