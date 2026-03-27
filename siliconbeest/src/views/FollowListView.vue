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
      <header class="sticky top-0 z-10 bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm border-b border-gray-200 dark:border-gray-700 px-4 py-3 flex items-center gap-3">
        <button @click="router.back()" class="p-1 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg>
        </button>
        <div>
          <h1 class="text-xl font-bold">{{ title }}</h1>
          <p class="text-sm text-gray-500 dark:text-gray-400">@{{ accountName }}</p>
        </div>
      </header>

      <LoadingSpinner v-if="loading" />

      <div v-else-if="accounts.length === 0" class="p-8 text-center text-gray-500 dark:text-gray-400">
        {{ isFollowers ? t('profile.no_followers') : t('profile.no_following') }}
      </div>

      <InfiniteScroll v-else :loading="loadingMore" :done="!hasMore" @load-more="loadMore">
        <AccountCard v-for="account in accounts" :key="account.id" :account="account" />
      </InfiniteScroll>
    </div>
  </AppShell>
</template>
