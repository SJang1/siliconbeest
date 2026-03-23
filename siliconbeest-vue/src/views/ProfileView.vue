<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import type { Account, Status } from '@/types/mastodon'
import AppShell from '@/components/layout/AppShell.vue'
import AccountHeader from '@/components/account/AccountHeader.vue'
import TimelineFeed from '@/components/timeline/TimelineFeed.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'

const { t } = useI18n()
const route = useRoute()

const account = ref<Account | null>(null)
const statuses = ref<Status[]>([])
const loading = ref(true)
const feedLoading = ref(false)
const feedDone = ref(false)

async function loadProfile(acct: string) {
  loading.value = true
  try {
    // TODO: fetch from API
    // account.value = await api.lookupAccount(acct)
    // statuses.value = await api.getAccountStatuses(account.value.id)
  } finally {
    loading.value = false
  }
}

async function loadMoreStatuses() {
  if (feedLoading.value || feedDone.value) return
  feedLoading.value = true
  try {
    // TODO: paginate
  } finally {
    feedLoading.value = false
  }
}

onMounted(() => {
  const acct = route.params.acct as string
  if (acct) loadProfile(acct)
})

watch(() => route.params.acct, (acct) => {
  if (acct) loadProfile(acct as string)
})
</script>

<template>
  <AppShell>
    <div>
      <header class="sticky top-0 z-10 bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm border-b border-gray-200 dark:border-gray-700 px-4 py-3">
        <h1 class="text-xl font-bold">{{ t('nav.profile') }}</h1>
      </header>

      <LoadingSpinner v-if="loading" />

      <template v-else-if="account">
        <AccountHeader :account="account" />
        <TimelineFeed
          :statuses="statuses"
          :loading="feedLoading"
          :done="feedDone"
          @load-more="loadMoreStatuses"
        />
      </template>

      <div v-else class="p-8 text-center text-gray-500 dark:text-gray-400">
        {{ t('profile.not_found') }}
      </div>
    </div>
  </AppShell>
</template>
