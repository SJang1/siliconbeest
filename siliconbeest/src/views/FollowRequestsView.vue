<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { apiFetch } from '@/api/client'
import AppShell from '@/components/layout/AppShell.vue'
import Avatar from '@/components/common/Avatar.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import type { Account } from '@/types/mastodon'

const { t } = useI18n()
const auth = useAuthStore()

const requests = ref<Account[]>([])
const loading = ref(true)
const error = ref('')

async function loadRequests() {
  loading.value = true
  error.value = ''
  try {
    const { data } = await apiFetch<Account[]>('/v1/follow_requests', {
      token: auth.token ?? undefined,
    })
    requests.value = data
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

async function handleAction(accountId: string, action: 'authorize' | 'reject') {
  try {
    await apiFetch(`/v1/follow_requests/${accountId}/${action}`, {
      method: 'POST',
      token: auth.token ?? undefined,
    })
    requests.value = requests.value.filter((r) => r.id !== accountId)
  } catch (e) {
    error.value = (e as Error).message
  }
}

onMounted(loadRequests)
</script>

<template>
  <AppShell>
    <div class="w-full">
      <header class="sticky top-0 z-10 bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm border-b border-gray-200 dark:border-gray-700 px-4 py-3">
        <h1 class="text-xl font-bold">{{ t('settings.follow_requests') }}</h1>
      </header>

      <LoadingSpinner v-if="loading" />

      <div v-else-if="error" class="p-4 text-red-500">{{ error }}</div>

      <div v-else-if="requests.length === 0" class="p-8 text-center text-gray-500 dark:text-gray-400">
        {{ t('settings.no_follow_requests') }}
      </div>

      <div v-else class="divide-y divide-gray-200 dark:divide-gray-700">
        <div
          v-for="account in requests"
          :key="account.id"
          class="px-4 py-3 flex items-center gap-3"
        >
          <router-link :to="`/@${account.acct}`" class="flex-shrink-0">
            <Avatar :src="account.avatar" :alt="account.display_name" size="md" />
          </router-link>

          <div class="flex-1 min-w-0">
            <router-link :to="`/@${account.acct}`" class="font-bold text-sm hover:underline truncate block">
              {{ account.display_name || account.username }}
            </router-link>
            <span class="text-xs text-gray-500 dark:text-gray-400 truncate block">@{{ account.acct }}</span>
          </div>

          <div class="flex gap-2">
            <button
              @click="handleAction(account.id, 'authorize')"
              class="px-3 py-1.5 text-sm font-medium rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
            >
              {{ t('settings.approve') }}
            </button>
            <button
              @click="handleAction(account.id, 'reject')"
              class="px-3 py-1.5 text-sm font-medium rounded-lg bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
            >
              {{ t('settings.reject') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </AppShell>
</template>
