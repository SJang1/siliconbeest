<script setup lang="ts">
import { ref, onMounted, watch, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import type { Account } from '@/types/mastodon'
import { lookupAccount, getFollowers, getFollowing } from '@/api/mastodon/accounts'
import { useAuthStore } from '@/stores/auth'
import AppShell from '@/components/layout/AppShell.vue'
import AccountCard from '@/components/account/AccountCard.vue'
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

const isFollowers = computed(() => route.name === 'profile-followers')
const title = computed(() => isFollowers.value ? t('profile.followers') : t('profile.following'))

async function load() {
  loading.value = true
  const acct = (route.params.acct as string).replace(/^@/, '')
  accountName.value = acct

  try {
    const { data: acctData } = await lookupAccount(acct, auth.token ?? undefined)
    const fetcher = isFollowers.value ? getFollowers : getFollowing
    const { data } = await fetcher(acctData.id, { token: auth.token ?? undefined })
    accounts.value = data
    if (data.length > 0 && data.length >= 40) {
      maxId.value = data[data.length - 1]!.id
    } else {
      hasMore.value = false
    }
  } catch {
    accounts.value = []
  } finally {
    loading.value = false
  }
}

async function loadMore() {
  if (loadingMore.value || !hasMore.value || !maxId.value) return
  loadingMore.value = true
  const acct = (route.params.acct as string).replace(/^@/, '')

  try {
    const { data: acctData } = await lookupAccount(acct, auth.token ?? undefined)
    const fetcher = isFollowers.value ? getFollowers : getFollowing
    const { data } = await fetcher(acctData.id, { token: auth.token ?? undefined, max_id: maxId.value! })
    accounts.value.push(...data)
    if (data.length > 0 && data.length >= 40) {
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

      <div v-else>
        <AccountCard v-for="account in accounts" :key="account.id" :account="account" />

        <div v-if="hasMore" class="p-4 text-center">
          <button
            @click="loadMore"
            :disabled="loadingMore"
            class="px-4 py-2 rounded-lg bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-sm"
          >
            {{ loadingMore ? '...' : t('common.load_more') }}
          </button>
        </div>
      </div>
    </div>
  </AppShell>
</template>
