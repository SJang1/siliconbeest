<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Account, Status, Tag } from '@/types/mastodon'
import { search as apiSearch } from '@/api/mastodon/search'
import { useAuthStore } from '@/stores/auth'
import { useStatusesStore } from '@/stores/statuses'
import AppShell from '@/components/layout/AppShell.vue'
import StatusCard from '@/components/status/StatusCard.vue'
import AccountCard from '@/components/account/AccountCard.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'

const { t } = useI18n()
const auth = useAuthStore()
const statusesStore = useStatusesStore()

type SearchTab = 'accounts' | 'statuses' | 'hashtags'

const query = ref('')
const activeTab = ref<SearchTab>('accounts')
const accounts = ref<Account[]>([])
const statuses = ref<Status[]>([])
const hashtags = ref<Tag[]>([])
const loading = ref(false)
const searched = ref(false)
const error = ref<string | null>(null)

function isUrlQuery(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

async function performSearch() {
  if (!query.value.trim()) return
  loading.value = true
  searched.value = true
  error.value = null
  try {
    const { data } = await apiSearch(query.value, {
      resolve: true,
      token: auth.token ?? undefined,
    })
    accounts.value = data.accounts
    statusesStore.cacheStatuses(data.statuses)
    statuses.value = data.statuses
    hashtags.value = data.hashtags
    if (isUrlQuery(query.value) && data.statuses.length > 0) {
      activeTab.value = 'statuses'
    }
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <AppShell>
    <div>
      <!-- Hero search -->
      <section class="px-4 pb-6 pt-10 sm:pt-14">
        <h1 class="sb-heading text-center text-3xl sm:text-4xl">
          <span class="sb-gradient-text">{{ t('search.title') }}</span>
        </h1>
        <form @submit.prevent="performSearch" class="mx-auto mt-6 flex w-full max-w-xl items-center gap-2">
          <div class="relative min-w-0 flex-1">
            <svg
              class="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400 dark:text-slate-500"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
            </svg>
            <input
              v-model="query"
              type="search"
              :placeholder="t('search.placeholder')"
              class="sb-input rounded-full py-3 pl-11 pr-4 text-base shadow-soft"
              :aria-label="t('search.placeholder')"
            />
          </div>
          <button
            type="submit"
            class="sb-btn sb-btn-primary shrink-0 px-5 py-3"
          >
            {{ t('search.submit') }}
          </button>
        </form>
      </section>

      <!-- Tabs -->
      <div v-if="searched" class="sb-glass sticky top-0 z-10 border-b px-4 py-2">
        <div class="mx-auto flex w-full max-w-xl items-center gap-1 overflow-x-auto">
          <button
            v-for="tab in (['accounts', 'statuses', 'hashtags'] as SearchTab[])"
            :key="tab"
            @click="activeTab = tab"
            class="whitespace-nowrap rounded-full px-4 py-1.5 text-sm font-semibold transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
            :class="activeTab === tab
              ? 'bg-brand-600 text-white shadow-soft dark:bg-brand-500'
              : 'text-slate-600 hover:bg-surface-2 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-surface-2-dark dark:hover:text-white'"
            :aria-pressed="activeTab === tab"
          >
            {{ t(`search.${tab}`) }}
          </button>
        </div>
      </div>

      <div v-if="error" class="mx-4 my-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-center text-sm font-medium text-red-600 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-400">
        {{ error }}
      </div>

      <LoadingSpinner v-if="loading" />

      <template v-else-if="searched">
        <!-- Accounts -->
        <section v-if="activeTab === 'accounts'" class="px-4 py-5">
          <h2 class="sb-heading mb-3 text-base text-slate-900 dark:text-slate-100">{{ t('search.accounts') }}</h2>
          <div class="space-y-3">
            <AccountCard
              v-for="account in accounts"
              :key="account.id"
              :account="account"
              show-follow-button
            />
          </div>
          <p v-if="accounts.length === 0" class="sb-empty">
            {{ t('search.no_results') }}
          </p>
        </section>

        <!-- Statuses -->
        <section v-if="activeTab === 'statuses'" class="px-4 py-5">
          <h2 class="sb-heading mb-3 text-base text-slate-900 dark:text-slate-100">{{ t('search.statuses') }}</h2>
          <div class="space-y-3">
            <StatusCard
              v-for="status in statuses"
              :key="status.id"
              :status="status"
            />
          </div>
          <p v-if="statuses.length === 0" class="sb-empty">
            {{ t('search.no_results') }}
          </p>
        </section>

        <!-- Hashtags -->
        <section v-if="activeTab === 'hashtags'" class="px-4 py-5">
          <h2 class="sb-heading mb-3 text-base text-slate-900 dark:text-slate-100">{{ t('search.hashtags') }}</h2>
          <div v-if="hashtags.length > 0" class="sb-card divide-y divide-outline overflow-hidden dark:divide-outline-dark">
            <router-link
              v-for="tag in hashtags"
              :key="tag.name"
              :to="`/tags/${tag.name}`"
              class="group flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-surface-2 dark:hover:bg-surface-2-dark"
            >
              <span class="flex min-w-0 items-center gap-3">
                <span
                  class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-950/60 dark:text-brand-300"
                  aria-hidden="true"
                >
                  <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M5.25 8.25h13.5m-14.25 7.5h13.5m-9-15L7.5 20.25m9-19.5l-2.25 19.5" />
                  </svg>
                </span>
                <span class="truncate font-bold text-slate-900 dark:text-slate-100">#{{ tag.name }}</span>
              </span>
              <svg
                class="h-5 w-5 shrink-0 text-slate-400 transition-colors group-hover:text-brand-500 dark:text-slate-500 dark:group-hover:text-brand-400"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path stroke-linecap="round" stroke-linejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
              </svg>
            </router-link>
          </div>
          <p v-if="hashtags.length === 0" class="sb-empty">
            {{ t('search.no_results') }}
          </p>
        </section>
      </template>
    </div>
  </AppShell>
</template>
