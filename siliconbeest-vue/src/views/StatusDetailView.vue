<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import type { Status } from '@/types/mastodon'
import AppShell from '@/components/layout/AppShell.vue'
import StatusCard from '@/components/status/StatusCard.vue'
import StatusComposer from '@/components/status/StatusComposer.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'

const { t } = useI18n()
const route = useRoute()

const status = ref<Status | null>(null)
const ancestors = ref<Status[]>([])
const descendants = ref<Status[]>([])
const loading = ref(true)

async function loadThread() {
  loading.value = true
  const id = route.params.id as string
  try {
    // TODO: fetch from API
    // status.value = await api.getStatus(id)
    // const context = await api.getStatusContext(id)
    // ancestors.value = context.ancestors
    // descendants.value = context.descendants
  } finally {
    loading.value = false
  }
}

async function handleReply(payload: { content: string; visibility?: string; sensitive?: boolean; spoiler_text?: string }) {
  // TODO: post reply
  console.log('reply', payload)
}

onMounted(loadThread)
</script>

<template>
  <AppShell>
    <div>
      <header class="sticky top-0 z-10 bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm border-b border-gray-200 dark:border-gray-700 px-4 py-3 flex items-center gap-3">
        <button @click="$router.back()" class="p-1 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800" :aria-label="t('common.back')">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg>
        </button>
        <h1 class="text-xl font-bold">{{ t('status.thread') }}</h1>
      </header>

      <LoadingSpinner v-if="loading" />

      <template v-else-if="status">
        <!-- Ancestors -->
        <StatusCard v-for="s in ancestors" :key="s.id" :status="s" />

        <!-- Main status -->
        <div class="border-l-4 border-indigo-500">
          <StatusCard :status="status" />
        </div>

        <!-- Reply composer -->
        <StatusComposer :reply-to="status" @submit="handleReply" />

        <!-- Descendants -->
        <StatusCard v-for="s in descendants" :key="s.id" :status="s" />
      </template>

      <div v-else class="p-8 text-center text-gray-500 dark:text-gray-400">
        {{ t('status.not_found') }}
      </div>
    </div>
  </AppShell>
</template>
