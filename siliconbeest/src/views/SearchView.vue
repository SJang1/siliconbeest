<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Account, Status, Tag } from '@/types/mastodon'
import { search as apiSearch } from '@/api/mastodon/search'
import { useAuthStore } from '@/stores/auth'
import AppShell from '@/components/layout/AppShell.vue'
import StatusCard from '@/components/status/StatusCard.vue'
import AccountCard from '@/components/account/AccountCard.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'

const { t } = useI18n()
const auth = useAuthStore()

type SearchTab = 'accounts' | 'statuses' | 'hashtags'

const query = ref('')
const activeTab = ref<SearchTab>('accounts')
const accounts = ref<Account[]>([])
const statuses = ref<Status[]>([])
const hashtags = ref<Tag[]>([])
const loading = ref(false)
const searched = ref(false)
const error = ref<string | null>(null)

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
    statuses.value = data.statuses
    hashtags.value = data.hashtags
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
      <header class="sticky top-0 z-10 bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm border-b border-gray-200 dark:border-gray-700 p-4">
        <form @submit.prevent="performSearch" class="flex gap-2">
          <input
            v-model="query"
            type="search"
            :placeholder="t('search.placeholder')"
            class="flex-1 px-4 py-2 rounded-full bg-gray-100 dark:bg-gray-800 border-0 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            :aria-label="t('search.placeholder')"
          />
          <button
            type="submit"
            class="px-4 py-2 rounded-full bg-indigo-600 hover:bg-indigo-700 text-white font-medium transition-colors"
          >
            {{ t('search.submit') }}
          </button>
        </form>

        <!-- Tabs -->
        <div v-if="searched" class="flex gap-1 mt-3">
          <button
            v-for="tab in (['accounts', 'statuses', 'hashtags'] as SearchTab[])"
            :key="tab"
            @click="activeTab = tab"
            class="px-3 py-1.5 rounded-full text-sm font-medium transition-colors"
            :class="activeTab === tab
              ? 'bg-indigo-600 text-white'
              : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'"
          >
            {{ t(`search.${tab}`) }}
          </button>
        </div>
      </header>

      <div v-if="error" class="p-4 text-center text-red-500">
        {{ error }}
      </div>

      <LoadingSpinner v-if="loading" />

      <template v-else-if="searched">
        <!-- Accounts -->
        <div v-if="activeTab === 'accounts'">
          <AccountCard
            v-for="account in accounts"
            :key="account.id"
            :account="account"
            show-follow-button
          />
          <p v-if="accounts.length === 0" class="p-4 text-center text-gray-500 dark:text-gray-400 text-sm">
            {{ t('search.no_results') }}
          </p>
        </div>

        <!-- Statuses -->
        <div v-if="activeTab === 'statuses'">
          <StatusCard
            v-for="status in statuses"
            :key="status.id"
            :status="status"
          />
          <p v-if="statuses.length === 0" class="p-4 text-center text-gray-500 dark:text-gray-400 text-sm">
            {{ t('search.no_results') }}
          </p>
        </div>

        <!-- Hashtags -->
        <div v-if="activeTab === 'hashtags'">
          <router-link
            v-for="tag in hashtags"
            :key="tag.name"
            :to="`/tags/${tag.name}`"
            class="block px-4 py-3 border-b border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
          >
            <p class="font-bold">#{{ tag.name }}</p>
          </router-link>
          <p v-if="hashtags.length === 0" class="p-4 text-center text-gray-500 dark:text-gray-400 text-sm">
            {{ t('search.no_results') }}
          </p>
        </div>
      </template>
    </div>
  </AppShell>
</template>
