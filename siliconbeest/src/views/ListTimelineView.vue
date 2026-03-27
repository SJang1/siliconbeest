<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { useStatusesStore } from '@/stores/statuses'
import { apiFetch, parseLinkHeader } from '@/api/client'
import type { Status } from '@/types/mastodon'
import AppShell from '@/components/layout/AppShell.vue'
import StatusCard from '@/components/status/StatusCard.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import InfiniteScroll from '@/components/common/InfiniteScroll.vue'

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

async function loadList() {
  const id = route.params.id as string
  if (!auth.token) return
  loading.value = true
  try {
    const { data } = await apiFetch<ListInfo>(`/v1/lists/${id}`, { token: auth.token })
    list.value = data
    await Promise.all([loadTimeline(), loadMembers()])
  } catch { /* */ }
  loading.value = false
}

async function loadTimeline() {
  const id = route.params.id as string
  if (!auth.token) return
  try {
    const { data, headers } = await apiFetch<Status[]>(`/v1/timelines/list/${id}?limit=20`, { token: auth.token })
    statuses.value = data
    data.forEach(s => statusesStore.cacheStatus(s))
    const links = parseLinkHeader(headers.get('Link'))
    done.value = !links.next
    maxId.value = data.length > 0 ? data[data.length - 1]!.id : null
  } catch { /* */ }
}

async function loadMore() {
  const id = route.params.id as string
  if (!auth.token || loadingMore.value || done.value || !maxId.value) return
  loadingMore.value = true
  try {
    const { data, headers } = await apiFetch<Status[]>(`/v1/timelines/list/${id}?limit=20&max_id=${maxId.value}`, { token: auth.token })
    statuses.value.push(...data)
    data.forEach(s => statusesStore.cacheStatus(s))
    const links = parseLinkHeader(headers.get('Link'))
    done.value = !links.next || data.length === 0
    maxId.value = data.length > 0 ? data[data.length - 1]!.id : null
  } catch { /* */ }
  loadingMore.value = false
}

async function loadMembers() {
  const id = route.params.id as string
  if (!auth.token) return
  try {
    const { data } = await apiFetch<ListAccount[]>(`/v1/lists/${id}/accounts`, { token: auth.token })
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
      <header class="sticky top-0 z-10 bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm border-b border-gray-200 dark:border-gray-700 px-4 py-3">
        <h1 class="text-xl font-bold text-gray-900 dark:text-white">📋 {{ list?.title ?? t('nav.lists') }}</h1>
      </header>

      <!-- Tabs -->
      <div class="flex border-b border-gray-200 dark:border-gray-700">
        <button
          @click="activeTab = 'timeline'"
          class="flex-1 py-3 text-sm font-medium text-center transition-colors"
          :class="activeTab === 'timeline' ? 'text-indigo-600 dark:text-indigo-400 border-b-2 border-indigo-600 dark:border-indigo-400' : 'text-gray-500 dark:text-gray-400'"
        >{{ t('nav.home') }}</button>
        <button
          @click="activeTab = 'members'"
          class="flex-1 py-3 text-sm font-medium text-center transition-colors"
          :class="activeTab === 'members' ? 'text-indigo-600 dark:text-indigo-400 border-b-2 border-indigo-600 dark:border-indigo-400' : 'text-gray-500 dark:text-gray-400'"
        >{{ t('lists.members') }} ({{ accounts.length }})</button>
      </div>

      <LoadingSpinner v-if="loading" />

      <!-- Timeline tab -->
      <template v-else-if="activeTab === 'timeline'">
        <div v-if="statuses.length === 0" class="p-8 text-center text-gray-500 dark:text-gray-400">
          <p class="text-lg font-medium">{{ t('lists.empty_timeline') }}</p>
          <p class="text-sm mt-1">{{ t('lists.empty_timeline_hint') }}</p>
        </div>
        <InfiniteScroll v-else :loading="loadingMore" :done="done" @load-more="loadMore">
          <StatusCard v-for="s in statuses" :key="s.id" :status="s" />
        </InfiniteScroll>
      </template>

      <!-- Members tab -->
      <template v-else>
        <!-- Search to add -->
        <div class="p-4 border-b border-gray-200 dark:border-gray-700">
          <input
            v-model="searchQuery"
            @input="searchAccounts"
            type="text"
            :placeholder="t('lists.search_members')"
            class="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-transparent dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <ul v-if="searchResults.length > 0" class="mt-2 divide-y divide-gray-100 dark:divide-gray-700">
            <li v-for="a in searchResults" :key="a.id" class="flex items-center justify-between py-2">
              <div class="flex items-center gap-2">
                <img :src="a.avatar" class="w-8 h-8 rounded-full" />
                <div>
                  <p class="text-sm font-medium text-gray-900 dark:text-white">{{ a.display_name || a.username }}</p>
                  <p class="text-xs text-gray-500">@{{ a.acct }}</p>
                </div>
              </div>
              <button @click="addMember(a)" class="px-3 py-1 text-xs bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">+ {{ t('lists.add') }}</button>
            </li>
          </ul>
        </div>

        <!-- Current members -->
        <ul class="divide-y divide-gray-200 dark:divide-gray-700">
          <li v-for="a in accounts" :key="a.id" class="flex items-center justify-between px-4 py-3">
            <router-link :to="`/@${a.acct}`" class="flex items-center gap-2">
              <img :src="a.avatar" class="w-10 h-10 rounded-full" />
              <div>
                <p class="text-sm font-medium text-gray-900 dark:text-white">{{ a.display_name || a.username }}</p>
                <p class="text-xs text-gray-500 dark:text-gray-400">@{{ a.acct }}</p>
              </div>
            </router-link>
            <button @click="removeMember(a.id)" class="p-1.5 text-gray-400 hover:text-red-500 transition-colors" :aria-label="t('lists.remove')">✕</button>
          </li>
        </ul>
        <div v-if="accounts.length === 0" class="p-8 text-center text-gray-500 dark:text-gray-400">
          {{ t('lists.no_members') }}
        </div>
      </template>
    </div>
  </AppShell>
</template>
