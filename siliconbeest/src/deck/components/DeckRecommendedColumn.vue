<script setup lang="ts">
import { computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import type { Status } from '@/types/mastodon'
import { useTimelinesStore } from '@/stores/timelines'
import { useStatusesStore } from '@/stores/statuses'
import { useAuthStore } from '@/stores/auth'
import { useRecommendedTimelineFeature } from '@/composables/useRecommendedTimelineFeature'
import InfiniteScroll from '@/components/common/InfiniteScroll.vue'
import DeckStatusCard from './DeckStatusCard.vue'
import AdvertisementCard from '@/components/advertisement/AdvertisementCard.vue'
import { useAdvertisementsStore } from '@/stores/advertisements'
import { mixAdvertisements } from '@/utils/advertisementFeed'

const { t } = useI18n()
const router = useRouter()
const timelinesStore = useTimelinesStore()
const statusesStore = useStatusesStore()
const auth = useAuthStore()
const advertisementsStore = useAdvertisementsStore()
const { available } = useRecommendedTimelineFeature()

withDefaults(defineProps<{
  fluid?: boolean
}>(), {
  fluid: false,
})

const timeline = computed(() => timelinesStore.getTimeline('recommended'))
const statuses = computed(() => timeline.value.statusIds
  .map(id => statusesStore.getCached(id))
  .filter((status): status is Status => !!status))
const feedItems = computed(() => mixAdvertisements(
  statuses.value,
  advertisementsStore.advertisements,
  'deck:recommended',
))

async function refreshRecommended() {
  if (!auth.token || !available.value) return
  await timelinesStore.refreshRecommendedTimeline(auth.token)
}

async function loadMore() {
  if (!auth.token || !available.value) return
  await timelinesStore.fetchMore('recommended', { token: auth.token })
}

function navigate(status: Status) {
  void router.push(`/@${status.account.acct}/${status.id}`)
}

watch(
  [() => auth.token, available],
  ([token, enabled], [previousToken, wasEnabled] = [null, false]) => {
    void advertisementsStore.load(token ?? undefined)
    if (token && enabled && (token !== previousToken || !wasEnabled)) {
      void refreshRecommended()
    }
  },
  { immediate: true },
)
</script>

<template>
  <section
    class="flex h-full min-h-0 flex-none flex-col gap-2.5"
    :class="fluid ? 'w-full' : 'w-[392px] max-w-full'"
    :aria-label="t('timeline.ai_recommended')"
  >
    <div class="dk-card flex flex-none items-center gap-2.5 rounded-[14px] px-3.5 py-2.5">
      <span class="text-base" aria-hidden="true">✨</span>
      <span class="dk-mono dk-text text-[13.5px] font-semibold">
        {{ t('timeline.ai_recommended') }}
      </span>
      <div class="flex-1" />
      <button
        type="button"
        class="dk-pill-btn shrink-0 text-[10.5px]"
        :disabled="timeline.loading || timeline.loadingMore"
        :aria-label="t('timeline.refresh_recommended')"
        @click="refreshRecommended"
      >
        {{ timeline.loading
          ? t('timeline.refreshing_recommended')
          : t('timeline.refresh_recommended') }}
      </button>
    </div>

    <div data-deck-scroll class="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-y-contain pb-1.5">
      <div
        v-if="timeline.error"
        class="dk-card dk-dim-text mb-2.5 px-4 py-3 text-center text-[13px]"
        role="alert"
      >
        <p class="dk-text font-semibold">{{ t('timeline.recommended_failed') }}</p>
        <p class="mt-1 whitespace-pre-line break-words">
          {{ t('timeline.recommended_failure_reason', { reason: timeline.error }) }}
        </p>
        <button
          type="button"
          class="dk-pill-btn mt-2 text-[10.5px]"
          :disabled="timeline.loading || timeline.loadingMore"
          @click="refreshRecommended"
        >
          {{ t('timeline.refresh_recommended') }}
        </button>
      </div>

      <InfiniteScroll
        v-if="!timeline.error || statuses.length > 0"
        :loading="timeline.loading || timeline.loadingMore"
        :done="!timeline.hasMore"
        @load-more="loadMore"
      >
        <div class="flex flex-col" style="gap: var(--dk-gap)">
          <template v-for="item in feedItems" :key="item.key">
            <DeckStatusCard
              v-if="item.kind === 'status'"
              :status="item.status"
              @navigate="navigate"
            />
            <AdvertisementCard
              v-else
              :advertisement="item.advertisement"
              variant="deck"
            >
              <template #status>
                <DeckStatusCard
                  v-if="item.advertisement.status"
                  :status="item.advertisement.status"
                  @navigate="navigate"
                />
              </template>
            </AdvertisementCard>
          </template>
        </div>
      </InfiniteScroll>
    </div>
  </section>
</template>
