<script setup lang="ts">
import { ref, onMounted, watch, computed } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import type { Account, Status, Relationship } from '@/types/mastodon'
import { lookupAccount, getAccountStatuses, followAccount, unfollowAccount } from '@/api/mastodon/accounts'
import { useAuthStore } from '@/stores/auth'
import { useAccountsStore } from '@/stores/accounts'
import { useStatusesStore } from '@/stores/statuses'
import { useInstanceStore } from '@/stores/instance'
import { parseLinkHeader } from '@/api/client'
import { useStatusPagePrefetch } from '@/composables/useStatusPagePrefetch'
import AppShell from '@/components/layout/AppShell.vue'
import AccountHeader from '@/components/account/AccountHeader.vue'
import TimelineFeed from '@/components/timeline/TimelineFeed.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'

const { t } = useI18n()
const route = useRoute()
const auth = useAuthStore()
const accountsStore = useAccountsStore()
const statusesStore = useStatusesStore()
const instanceStore = useInstanceStore()

const account = ref<Account | null>(null)
const relationship = ref<Relationship | null>(null)
const statuses = ref<Status[]>([])
const loading = ref(true)
const feedLoading = ref(false)
const feedDone = ref(false)
const maxId = ref<string>()
const error = ref<string | null>(null)
const pagePrefetch = useStatusPagePrefetch({
  feedKey: () => `profile:${account.value?.id ?? String(route.params.acct ?? '')}`,
  visibleStatuses: () => statuses.value,
})

const isOwn = computed(() => {
  if (!auth.currentUser || !account.value) return false
  return auth.currentUser.id === account.value.id
})

async function loadProfile(acct: string) {
  const generation = pagePrefetch.reset()
  loading.value = true
  error.value = null
  relationship.value = null
  statuses.value = []
  maxId.value = undefined
  feedDone.value = false

  try {
    const { data: acctData } = await lookupAccount(acct, auth.token ?? undefined)
    if (!pagePrefetch.isCurrent(generation)) return
    account.value = acctData
    accountsStore.cacheAccount(acctData)

    // Set dynamic page title
    const siteName = instanceStore.instance?.title
    const displayName = acctData.display_name || acctData.username || acct
    const profileTitle = `${displayName} (@${acctData.acct || acct})`
    document.title = siteName ? `${profileTitle} | ${siteName}` : profileTitle

    // Load relationship if authenticated and not own profile
    if (auth.token && !isOwn.value) {
      const rels = await accountsStore.getRelationships([acctData.id], auth.token)
      if (!pagePrefetch.isCurrent(generation)) return
      if (rels.length > 0) {
        relationship.value = rels[0]!
      }
    }

    // Load statuses
    const { data: statusData, headers } = await getAccountStatuses(acctData.id, {
      token: auth.token ?? undefined,
      exclude_replies: true,
    })
    if (!pagePrefetch.isCurrent(generation)) return
    statusesStore.cacheStatuses(statusData)
    statuses.value = statusData
    const links = parseLinkHeader(headers.get('Link'))
    feedDone.value = !links.next || statusData.length === 0
    if (statusData.length > 0) {
      maxId.value = statusData[statusData.length - 1]!.id
    }
    if (!feedDone.value && maxId.value) {
      const nextCursor = maxId.value
      pagePrefetch.prefetch(
        `${acctData.id}:${nextCursor}`,
        signal => getAccountStatuses(acctData.id, {
          max_id: nextCursor,
          token: auth.token ?? undefined,
          exclude_replies: true,
          signal,
        }),
        generation,
      )
    }
  } catch (e) {
    if (!pagePrefetch.isCurrent(generation)) return
    error.value = (e as Error).message
    account.value = null
  } finally {
    if (pagePrefetch.isCurrent(generation)) loading.value = false
  }
}

async function loadMoreStatuses() {
  if (feedLoading.value || feedDone.value || !account.value || !maxId.value) return
  feedLoading.value = true
  try {
    const accountId = account.value.id
    const cursor = maxId.value
    const response = await pagePrefetch.consume(
      `${accountId}:${cursor}`,
      signal => getAccountStatuses(accountId, {
        max_id: cursor,
        token: auth.token ?? undefined,
        exclude_replies: true,
        signal,
      }),
    )
    if (!response) return
    const { data, headers } = response
    statusesStore.cacheStatuses(data)
    statuses.value.push(...data)
    const links = parseLinkHeader(headers.get('Link'))
    feedDone.value = !links.next || data.length === 0
    if (data.length > 0) {
      maxId.value = data[data.length - 1]!.id
    }
    if (!feedDone.value && maxId.value) {
      const nextCursor = maxId.value
      pagePrefetch.prefetch(
        `${accountId}:${nextCursor}`,
        signal => getAccountStatuses(accountId, {
          max_id: nextCursor,
          token: auth.token ?? undefined,
          exclude_replies: true,
          signal,
        }),
      )
    }
  } finally {
    feedLoading.value = false
  }
}

async function handleFollowToggle() {
  if (!auth.token || !account.value) return
  try {
    const { data } = (relationship.value?.following || relationship.value?.requested)
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
      <header class="sb-glass sticky top-0 z-10 flex items-center gap-2 border-b px-4 py-3">
        <button @click="$router.back()" class="sb-btn sb-btn-ghost -ml-2 shrink-0 rounded-full p-2" :aria-label="t('common.back')">
          <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18"/></svg>
        </button>
        <h1 class="sb-heading truncate text-lg">{{ t('nav.profile') }}</h1>
      </header>

      <LoadingSpinner v-if="loading" />

      <div v-else-if="account" class="mx-auto w-full max-w-2xl animate-fade-in px-4 pb-10 pt-4">
        <AccountHeader
          :account="account"
          :is-own="isOwn"
          :relationship="relationship ?? undefined"
          @toggle-follow="handleFollowToggle"
          @relationship-updated="(r) => { relationship = r; accountsStore.updateRelationship(r) }"
        />

        <!-- Feed section marker (pill treatment) -->
        <div class="mt-5">
          <div class="inline-flex items-center rounded-full border border-outline bg-surface-2 p-1 dark:border-outline-dark dark:bg-surface-2-dark">
            <span class="rounded-full bg-surface px-4 py-1.5 text-xs font-semibold text-brand-700 shadow-soft dark:bg-surface-dark dark:text-brand-300">
              {{ t('profile.posts') }}
            </span>
          </div>
        </div>

        <div class="mt-3">
          <TimelineFeed
            :statuses="statuses"
            :loading="feedLoading"
            :done="feedDone"
            @load-more="loadMoreStatuses"
          />
        </div>
      </div>

      <div v-else class="sb-empty px-4">
        <svg class="h-8 w-8 text-slate-300 dark:text-slate-600" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z"/></svg>
        <p>{{ error || t('profile.not_found') }}</p>
      </div>
    </div>
  </AppShell>
</template>
