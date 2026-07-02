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
      <header class="sb-glass sticky top-0 z-10 border-b px-4 py-3">
        <h1 class="sb-heading truncate text-lg">{{ t('settings.follow_requests') }}</h1>
      </header>

      <LoadingSpinner v-if="loading" />

      <div v-else-if="error" class="mx-auto w-full max-w-2xl px-4 pt-6">
        <div class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-600 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-400">
          {{ error }}
        </div>
      </div>

      <div v-else-if="requests.length === 0" class="sb-empty px-4">
        <svg class="h-8 w-8 text-slate-300 dark:text-slate-600" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M18 7.5v3m0 0v3m0-3h3m-3 0h-3m-2.25-4.125a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0ZM3 19.235v-.11a6.375 6.375 0 0 1 12.75 0v.109A12.318 12.318 0 0 1 9.374 21c-2.331 0-4.512-.645-6.374-1.766Z"/></svg>
        <p>{{ t('settings.no_follow_requests') }}</p>
      </div>

      <div v-else class="mx-auto w-full max-w-2xl animate-fade-in px-4 py-4">
        <div class="sb-card divide-y divide-outline overflow-hidden dark:divide-outline-dark">
          <div
            v-for="account in requests"
            :key="account.id"
            class="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2 dark:hover:bg-surface-2-dark"
          >
            <router-link :to="`/@${account.acct}`" class="flex-shrink-0">
              <Avatar :src="account.avatar" :alt="account.display_name" size="md" />
            </router-link>

            <div class="min-w-0 flex-1">
              <router-link :to="`/@${account.acct}`" class="block truncate text-sm font-semibold text-slate-900 hover:underline dark:text-slate-100">
                {{ account.display_name || account.username }}
              </router-link>
              <span class="block truncate text-xs text-slate-500 dark:text-slate-400">@{{ account.acct }}</span>
            </div>

            <div class="flex shrink-0 items-center gap-2">
              <button
                @click="handleAction(account.id, 'authorize')"
                class="sb-btn sb-btn-primary sb-btn-sm"
              >
                {{ t('settings.approve') }}
              </button>
              <button
                @click="handleAction(account.id, 'reject')"
                class="sb-btn sb-btn-secondary sb-btn-sm"
              >
                {{ t('settings.reject') }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </AppShell>
</template>
