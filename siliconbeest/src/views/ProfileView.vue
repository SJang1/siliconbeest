<script setup lang="ts">
import { ref, onMounted, watch, computed } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import type { Account, Status, Relationship } from '@/types/mastodon'
import { lookupAccount, getAccountStatuses, followAccount, unfollowAccount } from '@/api/mastodon/accounts'
import { useAuthStore } from '@/stores/auth'
import { useAccountsStore } from '@/stores/accounts'
import { useInstanceStore } from '@/stores/instance'
import { parseLinkHeader } from '@/api/client'
import AppShell from '@/components/layout/AppShell.vue'
import AccountHeader from '@/components/account/AccountHeader.vue'
import TimelineFeed from '@/components/timeline/TimelineFeed.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'

const { t } = useI18n()
const route = useRoute()
const auth = useAuthStore()
const accountsStore = useAccountsStore()
const instanceStore = useInstanceStore()

const account = ref<Account | null>(null)
const relationship = ref<Relationship | null>(null)
const statuses = ref<Status[]>([])
const loading = ref(true)
const feedLoading = ref(false)
const feedDone = ref(false)
const maxId = ref<string>()
const error = ref<string | null>(null)

const isOwn = computed(() => {
  if (!auth.currentUser || !account.value) return false
  return auth.currentUser.id === account.value.id
})

async function loadProfile(acct: string) {
  loading.value = true
  error.value = null
  statuses.value = []
  maxId.value = undefined
  feedDone.value = false

  try {
    const { data: acctData } = await lookupAccount(acct, auth.token ?? undefined)
    account.value = acctData
    accountsStore.cacheAccount(acctData)

    // Set dynamic page title
    const siteName = instanceStore.instance?.title || 'SiliconBeest'
    const displayName = acctData.display_name || acctData.username || acct
    document.title = `${displayName} (@${acctData.acct || acct}) | ${siteName}`

    // Load relationship if authenticated and not own profile
    if (auth.token && !isOwn.value) {
      const rels = await accountsStore.getRelationships([acctData.id], auth.token)
      if (rels.length > 0) {
        relationship.value = rels[0]!
      }
    }

    // Load statuses
    const { data: statusData, headers } = await getAccountStatuses(acctData.id, {
      token: auth.token ?? undefined,
      exclude_replies: true,
    })
    statuses.value = statusData
    const links = parseLinkHeader(headers.get('Link'))
    feedDone.value = !links.next
    if (statusData.length > 0) {
      maxId.value = statusData[statusData.length - 1]!.id
    }
  } catch (e) {
    error.value = (e as Error).message
    account.value = null
  } finally {
    loading.value = false
  }
}

async function loadMoreStatuses() {
  if (feedLoading.value || feedDone.value || !account.value) return
  feedLoading.value = true
  try {
    const { data, headers } = await getAccountStatuses(account.value.id, {
      max_id: maxId.value,
      token: auth.token ?? undefined,
      exclude_replies: true,
    })
    statuses.value.push(...data)
    const links = parseLinkHeader(headers.get('Link'))
    feedDone.value = !links.next
    if (data.length > 0) {
      maxId.value = data[data.length - 1]!.id
    }
  } finally {
    feedLoading.value = false
  }
}

async function handleFollowToggle() {
  if (!auth.token || !account.value) return
  try {
    const { data } = relationship.value?.following
      ? await unfollowAccount(account.value.id, auth.token)
      : await followAccount(account.value.id, auth.token)
    relationship.value = data
    accountsStore.updateRelationship(data)
  } catch (e) {
    // silently fail
  }
}

function cleanAcct(raw: string): string {
  // Remove leading @ if present (from URL encoding %40 → @)
  return raw.replace(/^@/, '')
}

onMounted(() => {
  const acct = route.params.acct as string
  if (acct) loadProfile(cleanAcct(acct))
})

watch(() => route.params.acct, (acct) => {
  if (acct) loadProfile(cleanAcct(acct as string))
})
</script>

<template>
  <AppShell>
    <div>
      <header class="sticky top-0 z-10 bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm border-b border-gray-200 dark:border-gray-700 px-4 py-3 flex items-center gap-3">
        <button @click="$router.back()" class="p-1 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800" :aria-label="t('common.back')">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg>
        </button>
        <h1 class="text-xl font-bold">{{ t('nav.profile') }}</h1>
      </header>

      <LoadingSpinner v-if="loading" />

      <template v-else-if="account">
        <AccountHeader
          :account="account"
          :is-own="isOwn"
          :relationship="relationship ?? undefined"
          @toggle-follow="handleFollowToggle"
        />
        <TimelineFeed
          :statuses="statuses"
          :loading="feedLoading"
          :done="feedDone"
          @load-more="loadMoreStatuses"
        />
      </template>

      <div v-else class="p-8 text-center text-gray-500 dark:text-gray-400">
        {{ error || t('profile.not_found') }}
      </div>
    </div>
  </AppShell>
</template>
