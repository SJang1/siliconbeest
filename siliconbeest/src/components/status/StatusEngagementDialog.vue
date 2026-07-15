<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Account } from '@/types/mastodon'
import { getFavouritedBy, getRebloggedBy } from '@/api/mastodon/statuses'
import { parseLinkHeader } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import Modal from '../common/Modal.vue'
import LegacyModal from '@/legacy/components/common/Modal.vue'
import LoadingSpinner from '../common/LoadingSpinner.vue'
import AccountCard from '../account/AccountCard.vue'
import LegacyAccountCard from '@/legacy/components/account/AccountCard.vue'

type EngagementKind = 'favourites' | 'reblogs'

const props = defineProps<{
  open: boolean
  statusId: string
  kind: EngagementKind
  variant?: 'aurora' | 'legacy' | 'deck'
}>()

const emit = defineEmits<{
  close: []
}>()

const { t } = useI18n()
const auth = useAuthStore()

const accounts = ref<Account[]>([])
const loading = ref(false)
const loadingMore = ref(false)
const initialError = ref(false)
const loadMoreError = ref(false)
const nextCursor = ref<string | null>(null)
let requestGeneration = 0

const title = computed(() => (
  props.kind === 'favourites'
    ? t('status.favourited_by')
    : t('status.reblogged_by')
))
const modalComponent = computed(() => props.variant === 'legacy' ? LegacyModal : Modal)
const accountCardComponent = computed(() => props.variant === 'legacy' ? LegacyAccountCard : AccountCard)

function getNextCursor(linkHeader: string | null): string | null {
  const next = parseLinkHeader(linkHeader).next
  if (!next) return null

  try {
    return new URL(next, 'https://siliconbeest.invalid').searchParams.get('max_id')
  } catch {
    return null
  }
}

async function fetchPage(cursor: string | undefined, append: boolean, generation: number) {
  const token = auth.token
  if (!token) return

  if (append) {
    loadingMore.value = true
    loadMoreError.value = false
  } else {
    loading.value = true
    initialError.value = false
  }

  try {
    const fetcher = props.kind === 'favourites' ? getFavouritedBy : getRebloggedBy
    const { data, headers } = await fetcher(props.statusId, token, {
      maxId: cursor,
      limit: 20,
    })

    if (generation !== requestGeneration) return

    if (append) {
      const existingIds = new Set(accounts.value.map((account) => account.id))
      accounts.value.push(...data.filter((account) => !existingIds.has(account.id)))
    } else {
      accounts.value = data
    }
    nextCursor.value = getNextCursor(headers.get('Link'))
  } catch {
    if (generation !== requestGeneration) return
    if (append) {
      loadMoreError.value = true
    } else {
      initialError.value = true
    }
  } finally {
    if (generation === requestGeneration) {
      loading.value = false
      loadingMore.value = false
    }
  }
}

function resetAndLoad() {
  requestGeneration += 1
  accounts.value = []
  nextCursor.value = null
  initialError.value = false
  loadMoreError.value = false
  loading.value = false
  loadingMore.value = false

  if (!props.open || !auth.token) return
  void fetchPage(undefined, false, requestGeneration)
}

function loadMore() {
  if (!nextCursor.value || loadingMore.value || !auth.token) return
  void fetchPage(nextCursor.value, true, requestGeneration)
}

watch(
  () => [props.open, props.statusId, props.kind, auth.token] as const,
  resetAndLoad,
  { immediate: true },
)

onUnmounted(() => {
  requestGeneration += 1
})
</script>

<template>
  <component :is="modalComponent" :open="open" :title="title" @close="emit('close')">
    <div class="-mx-4 sm:-mx-6" :aria-busy="loading || loadingMore" @click.stop>
      <div
        v-if="!auth.token"
        class="px-5 py-10 text-center text-sm text-slate-600 dark:text-slate-300"
        role="alert"
      >
        {{ t('status.engagement_login_required') }}
      </div>

      <div v-else-if="loading" class="flex min-h-32 items-center justify-center" role="status">
        <LoadingSpinner />
        <span class="sr-only">{{ t('common.loading') }}</span>
      </div>

      <div v-else-if="initialError" class="px-5 py-10 text-center" role="alert">
        <p class="text-sm text-slate-600 dark:text-slate-300">
          {{ t('status.engagement_load_error') }}
        </p>
        <button data-test="engagement-retry" type="button" class="sb-btn sb-btn-secondary mt-4" @click="resetAndLoad">
          {{ t('common.retry') }}
        </button>
      </div>

      <div
        v-else-if="accounts.length === 0"
        data-test="engagement-empty"
        class="px-5 py-10 text-center text-sm text-slate-500 dark:text-slate-400"
      >
        {{ t('status.engagement_empty') }}
      </div>

      <template v-else>
        <div class="divide-y divide-outline dark:divide-outline-dark">
          <component
            :is="accountCardComponent"
            v-for="account in accounts"
            :key="account.id"
            :account="account"
          />
        </div>

        <div v-if="nextCursor || loadMoreError" class="border-t border-outline px-4 pt-4 dark:border-outline-dark">
          <p v-if="loadMoreError" class="mb-3 text-center text-sm text-red-600 dark:text-red-400" role="alert">
            {{ t('status.engagement_load_error') }}
          </p>
          <button
            data-test="engagement-load-more"
            type="button"
            class="sb-btn sb-btn-secondary mx-auto flex min-h-11"
            :disabled="loadingMore"
            @click="loadMore"
          >
            {{ loadingMore ? t('common.loading') : t('common.load_more') }}
          </button>
        </div>
      </template>
    </div>
  </component>
</template>
