<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { useStatusesStore } from '@/stores/statuses'
import { apiFetch, parseLinkHeader } from '@/api/client'
import type { Status } from '@/types/mastodon'
import { useStatusPagePrefetch } from '@/composables/useStatusPagePrefetch'
import AppShell from '@/components/layout/AppShell.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import TimelineFeed from '@/components/timeline/TimelineFeed.vue'

const { t } = useI18n()
const route = useRoute()
const auth = useAuthStore()
const statusesStore = useStatusesStore()

interface ListInfo { id: string; title: string; replies_policy: string }
interface ListAccount { id: string; username: string; acct: string; display_name: string; avatar: string }

const list = ref<ListInfo | null>(null)
const statuses = ref<Status[]>([])
const accounts = ref<ListAccount[]>([])
const loading = ref(true)
const loadingMore = ref(false)
const done = ref(false)
const maxId = ref<string | null>(null)
const activeTab = ref<'timeline' | 'members'>('timeline')
const searchQuery = ref('')
const searchResults = ref<ListAccount[]>([])
const searching = ref(false)
const pagePrefetch = useStatusPagePrefetch({
  feedKey: () => `list:${String(route.params.id ?? '')}`,
  visibleStatuses: () => statuses.value,
})

function requestListPage(
  id: string,
  cursor: string | undefined,
  signal?: AbortSignal,
) {
  const maxIdParam = cursor ? `&max_id=${cursor}` : ''
  return apiFetch<Status[]>(
    `/v1/timelines/list/${id}?limit=20${maxIdParam}`,
    { token: auth.token!, signal },
  )
}

async function loadList() {
  const id = route.params.id as string
  if (!auth.token) return
  const generation = pagePrefetch.reset()
  loading.value = true
  statuses.value = []
  maxId.value = null
  done.value = false
  try {
    const { data } = await apiFetch<ListInfo>(`/v1/lists/${id}`, { token: auth.token })
    if (!pagePrefetch.isCurrent(generation)) return
    list.value = data
    await Promise.all([
      loadTimeline(id, generation),
      loadMembers(id, generation),
    ])
  } catch { /* */ }
  if (pagePrefetch.isCurrent(generation)) loading.value = false
}

async function loadTimeline(id: string, generation: number) {
  if (!auth.token) return
  try {
    const { data, headers } = await requestListPage(id, undefined)
    if (!pagePrefetch.isCurrent(generation)) return
    statuses.value = data
    data.forEach(s => statusesStore.cacheStatus(s))
    const links = parseLinkHeader(headers.get('Link'))
    done.value = !links.next || data.length === 0
    maxId.value = data.length > 0 ? data[data.length - 1]!.id : null
    if (!done.value && maxId.value) {
      const nextCursor = maxId.value
      pagePrefetch.prefetch(
        `${id}:${nextCursor}`,
        signal => requestListPage(id, nextCursor, signal),
        generation,
      )
    }
  } catch { /* */ }
}

async function loadMore() {
  const id = route.params.id as string
  if (!auth.token || loadingMore.value || done.value || !maxId.value) return
  loadingMore.value = true
  try {
    const cursor = maxId.value
    const response = await pagePrefetch.consume(
      `${id}:${cursor}`,
      signal => requestListPage(id, cursor, signal),
    )
    if (!response) return
    const { data, headers } = response
    statuses.value.push(...data)
    data.forEach(s => statusesStore.cacheStatus(s))
    const links = parseLinkHeader(headers.get('Link'))
    done.value = !links.next || data.length === 0
    maxId.value = data.length > 0 ? data[data.length - 1]!.id : null
    if (!done.value && maxId.value) {
      const nextCursor = maxId.value
      pagePrefetch.prefetch(
        `${id}:${nextCursor}`,
        signal => requestListPage(id, nextCursor, signal),
      )
    }
  } catch { /* */ }
  finally {
    loadingMore.value = false
  }
}

async function loadMembers(id: string, generation?: number) {
  if (!auth.token) return
  try {
    const { data } = await apiFetch<ListAccount[]>(`/v1/lists/${id}/accounts`, { token: auth.token })
    if (generation !== undefined && !pagePrefetch.isCurrent(generation)) return
    accounts.value = data
  } catch { /* */ }
}

async function searchAccounts() {
  if (!auth.token || !searchQuery.value.trim()) { searchResults.value = []; return }
  searching.value = true
  try {
    const { data } = await apiFetch<ListAccount[]>(`/v1/accounts/search?q=${encodeURIComponent(searchQuery.value)}&limit=5&following=true`, { token: auth.token })
    searchResults.value = data.filter(a => !accounts.value.some(m => m.id === a.id))
  } catch { /* */ }
  searching.value = false
}

async function addMember(account: ListAccount) {
  const id = route.params.id as string
  if (!auth.token) return
  try {
    await apiFetch(`/v1/lists/${id}/accounts`, {
      method: 'POST',
      body: JSON.stringify({ account_ids: [account.id] }),
      token: auth.token,
    })
    accounts.value.push(account)
    searchResults.value = searchResults.value.filter(a => a.id !== account.id)
  } catch { /* */ }
}

async function removeMember(accountId: string) {
  const id = route.params.id as string
  if (!auth.token) return
  try {
    await apiFetch(`/v1/lists/${id}/accounts?account_ids[]=${accountId}`, {
      method: 'DELETE',
      token: auth.token,
    })
    accounts.value = accounts.value.filter(a => a.id !== accountId)
  } catch { /* */ }
}

onMounted(loadList)
watch(() => route.params.id, () => { if (route.params.id) loadList() })
</script>

<template>
  <AppShell>
    <div class="w-full">
      <header class="sb-glass sticky top-0 z-10 border-b px-4 py-3">
        <h1 class="sb-heading flex items-center gap-2.5 text-lg text-slate-900 dark:text-white">
          <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-950/60 dark:text-brand-300" aria-hidden="true">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="h-4.5 w-4.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 0 1 0 3.75H5.625a1.875 1.875 0 0 1 0-3.75Z" />
            </svg>
          </span>
          <span class="truncate">{{ list?.title ?? t('nav.lists') }}</span>
        </h1>
      </header>

      <!-- Tabs -->
      <div class="flex border-b border-outline dark:border-outline-dark">
        <button
          @click="activeTab = 'timeline'"
          class="-mb-px flex-1 border-b-2 py-3 text-center text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-400"
          :class="activeTab === 'timeline' ? 'border-brand-600 text-brand-600 dark:border-brand-400 dark:text-brand-400' : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'"
        >{{ t('nav.home') }}</button>
        <button
          @click="activeTab = 'members'"
          class="-mb-px flex-1 border-b-2 py-3 text-center text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-400"
          :class="activeTab === 'members' ? 'border-brand-600 text-brand-600 dark:border-brand-400 dark:text-brand-400' : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'"
        >{{ t('lists.members') }} ({{ accounts.length }})</button>
      </div>

      <LoadingSpinner v-if="loading" />

      <!-- Timeline tab -->
      <template v-else-if="activeTab === 'timeline'">
        <div v-if="statuses.length === 0" class="sb-empty animate-fade-in px-4">
          <span class="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-50 text-brand-600 dark:bg-brand-950/60 dark:text-brand-300" aria-hidden="true">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="h-6 w-6">
              <path stroke-linecap="round" stroke-linejoin="round" d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 0 1-.825-.242m9.345-8.334a2.126 2.126 0 0 0-.476-.095 48.64 48.64 0 0 0-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0 0 11.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155" />
            </svg>
          </span>
          <p class="text-base font-semibold text-slate-700 dark:text-slate-200">{{ t('lists.empty_timeline') }}</p>
          <p class="text-sm">{{ t('lists.empty_timeline_hint') }}</p>
        </div>
        <TimelineFeed
          v-else
          :statuses="statuses"
          :loading="loadingMore"
          :done="done"
          :timeline-key="`list:${route.params.id}`"
          show-advertisements
          @load-more="loadMore"
        />
      </template>

      <!-- Members tab -->
      <template v-else>
        <!-- Search to add -->
        <div class="border-b border-outline p-4 dark:border-outline-dark">
          <div class="relative">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="pointer-events-none absolute left-3.5 top-1/2 h-4.5 w-4.5 -translate-y-1/2 text-slate-400 dark:text-slate-500" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
            </svg>
            <input
              v-model="searchQuery"
              @input="searchAccounts"
              type="text"
              :placeholder="t('lists.search_members')"
              class="sb-input pl-10"
            />
          </div>
          <ul v-if="searchResults.length > 0" class="mt-3 divide-y divide-outline overflow-hidden rounded-xl border border-outline bg-surface-2/50 dark:divide-outline-dark dark:border-outline-dark dark:bg-surface-2-dark/50">
            <li v-for="a in searchResults" :key="a.id" class="flex items-center justify-between gap-3 px-3 py-2.5 animate-fade-in">
              <div class="flex min-w-0 items-center gap-2.5">
                <img :src="a.avatar" alt="" class="h-8 w-8 shrink-0 rounded-full object-cover ring-1 ring-outline dark:ring-outline-dark" />
                <div class="min-w-0">
                  <p class="truncate text-sm font-medium text-slate-900 dark:text-white">{{ a.display_name || a.username }}</p>
                  <p class="truncate text-xs text-slate-500 dark:text-slate-400">@{{ a.acct }}</p>
                </div>
              </div>
              <button @click="addMember(a)" class="sb-btn sb-btn-primary sb-btn-sm shrink-0">+ {{ t('lists.add') }}</button>
            </li>
          </ul>
        </div>

        <!-- Current members -->
        <ul class="divide-y divide-outline dark:divide-outline-dark">
          <li v-for="a in accounts" :key="a.id" class="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-surface-2/60 dark:hover:bg-surface-2-dark/60">
            <router-link :to="`/@${a.acct}`" class="group flex min-w-0 items-center gap-3">
              <img :src="a.avatar" alt="" class="h-10 w-10 shrink-0 rounded-full object-cover ring-1 ring-outline dark:ring-outline-dark" />
              <div class="min-w-0">
                <p class="truncate text-sm font-medium text-slate-900 transition-colors group-hover:text-brand-600 dark:text-white dark:group-hover:text-brand-400">{{ a.display_name || a.username }}</p>
                <p class="truncate text-xs text-slate-500 dark:text-slate-400">@{{ a.acct }}</p>
              </div>
            </router-link>
            <button @click="removeMember(a.id)" class="shrink-0 rounded-full p-2 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 dark:hover:bg-red-950/40 dark:hover:text-red-400" :aria-label="t('lists.remove')">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="h-4 w-4" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
              </svg>
            </button>
          </li>
        </ul>
        <div v-if="accounts.length === 0" class="sb-empty animate-fade-in px-4">
          <span class="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-50 text-brand-600 dark:bg-brand-950/60 dark:text-brand-300" aria-hidden="true">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="h-6 w-6">
              <path stroke-linecap="round" stroke-linejoin="round" d="M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z" />
            </svg>
          </span>
          <p>{{ t('lists.no_members') }}</p>
        </div>
      </template>
    </div>
  </AppShell>
</template>
