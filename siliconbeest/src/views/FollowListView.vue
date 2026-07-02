<script setup lang="ts">
import { ref, onMounted, watch, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import type { Account } from '@/types/mastodon'
import { lookupAccount, getFollowers, getFollowing } from '@/api/mastodon/accounts'
import { parseLinkHeader } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import AppShell from '@/components/layout/AppShell.vue'
import AccountCard from '@/components/account/AccountCard.vue'
import InfiniteScroll from '@/components/common/InfiniteScroll.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

const accounts = ref<Account[]>([])
const loading = ref(true)
const accountName = ref('')
const maxId = ref<string | null>(null)
const hasMore = ref(true)
const loadingMore = ref(false)
const resolvedAccountId = ref<string | null>(null)

const isFollowers = computed(() => route.name === 'profile-followers')
const title = computed(() => isFollowers.value ? t('profile.followers') : t('profile.following'))

async function load() {
  loading.value = true
  accounts.value = []
  maxId.value = null
  hasMore.value = true
  resolvedAccountId.value = null

  const acct = (route.params.acct as string).replace(/^@/, '')
  accountName.value = acct

  try {
    const { data: acctData } = await lookupAccount(acct, auth.token ?? undefined)
    resolvedAccountId.value = acctData.id

    const fetcher = isFollowers.value ? getFollowers : getFollowing
    const { data, headers } = await fetcher(acctData.id, { token: auth.token ?? undefined })
    accounts.value = data

    // Use Link header to determine if there are more pages
    const links = parseLinkHeader(headers.get('Link'))
    hasMore.value = !!links.next

    if (data.length > 0) {
      maxId.value = data[data.length - 1]!.id
    }
  } catch {
    accounts.value = []
    hasMore.value = false
  } finally {
    loading.value = false
  }
}

async function loadMore() {
  if (loadingMore.value || !hasMore.value || !maxId.value || !resolvedAccountId.value) return
  loadingMore.value = true

  try {
    const fetcher = isFollowers.value ? getFollowers : getFollowing
    const { data, headers } = await fetcher(resolvedAccountId.value, {
      token: auth.token ?? undefined,
      max_id: maxId.value,
    })
    accounts.value.push(...data)

    const links = parseLinkHeader(headers.get('Link'))
    hasMore.value = !!links.next

    if (data.length > 0) {
      maxId.value = data[data.length - 1]!.id
    } else {
      hasMore.value = false
    }
  } catch {
    hasMore.value = false
  } finally {
    loadingMore.value = false
  }
}

onMounted(load)
watch(() => [route.params.acct, route.name], load)
</script>

<template>
  <AppShell>
    <div>
      <header class="sb-glass sticky top-0 z-10 flex items-center gap-2 border-b px-4 py-3">
        <button @click="router.back()" class="sb-btn sb-btn-ghost -ml-2 shrink-0 rounded-full p-2" :aria-label="t('common.back')">
          <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18"/></svg>
        </button>
        <div class="min-w-0">
          <h1 class="sb-heading truncate text-lg">{{ title }}</h1>
          <p class="truncate text-xs text-slate-500 dark:text-slate-400">@{{ accountName }}</p>
        </div>
      </header>

      <LoadingSpinner v-if="loading" />

      <div v-else-if="accounts.length === 0" class="sb-empty px-4">
        <svg class="h-8 w-8 text-slate-300 dark:text-slate-600" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M18 18.72a9.094 9.094 0 0 0 3.741-.479 3 3 0 0 0-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0 1 12 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 0 1 6 18.719m12 0a5.971 5.971 0 0 0-.941-3.197m0 0A5.995 5.995 0 0 0 12 12.75a5.995 5.995 0 0 0-5.058 2.772m0 0a3 3 0 0 0-4.681 2.72 8.986 8.986 0 0 0 3.74.477m.94-3.197a5.971 5.971 0 0 0-.94 3.197M15 6.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 3a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Zm-13.5 0a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Z"/></svg>
        <p>{{ isFollowers ? t('profile.no_followers') : t('profile.no_following') }}</p>
      </div>

      <div v-else class="mx-auto w-full max-w-2xl animate-fade-in px-4 py-4">
        <InfiniteScroll :loading="loadingMore" :done="!hasMore" @load-more="loadMore">
          <div class="sb-card overflow-hidden">
            <AccountCard v-for="account in accounts" :key="account.id" :account="account" />
          </div>
        </InfiniteScroll>
      </div>
    </div>
  </AppShell>
</template>
