<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import type { Status } from '@/types/mastodon'
import { useTimelinesStore, type TimelineType } from '@/stores/timelines'
import { useStatusesStore } from '@/stores/statuses'
import { useAuthStore } from '@/stores/auth'
import { useInstanceStore } from '@/stores/instance'
import InfiniteScroll from '@/components/common/InfiniteScroll.vue'
import DeckStatusCard from './DeckStatusCard.vue'
import AdvertisementCard from '@/components/advertisement/AdvertisementCard.vue'
import { useAdvertisementsStore } from '@/stores/advertisements'
import { mixAdvertisements } from '@/utils/advertisementFeed'
import { useTimelineStreamViewport } from '@/composables/useTimelineStreamViewport'

type DeckTimelineColumnType = 'home' | 'social' | 'local' | 'federated'

const { t } = useI18n()
const router = useRouter()
const timelinesStore = useTimelinesStore()
const statusesStore = useStatusesStore()
const auth = useAuthStore()
const instanceStore = useInstanceStore()
const advertisementsStore = useAdvertisementsStore()

const props = withDefaults(defineProps<{
  type: DeckTimelineColumnType
  fluid?: boolean
}>(), {
  fluid: false,
})

const COLUMN_META: Record<DeckTimelineColumnType, { emoji: string; timelineType: TimelineType; streamKeys: string[] }> = {
  home: { emoji: '🏠', timelineType: 'home', streamKeys: ['user'] },
  social: { emoji: '🫂', timelineType: 'social', streamKeys: ['user', 'public:local'] },
  local: { emoji: '🦬', timelineType: 'local', streamKeys: ['public:local'] },
  federated: { emoji: '📡', timelineType: 'public', streamKeys: ['public'] },
}

const meta = computed(() => COLUMN_META[props.type])
const title = computed(() => t(`deck.col_${props.type}`))
const scope = computed(() => {
  if (props.type === 'home') return t('deck.scope_following')
  if (props.type === 'social') return t('deck.scope_social')
  if (props.type === 'local') return instanceStore.instance?.domain || ''
  return t('deck.scope_federated')
})

const timeline = computed(() => timelinesStore.getTimeline(meta.value.timelineType))

const statuses = computed(() => {
  return timeline.value.statusIds
    .map((id) => statusesStore.getCached(id))
    .filter((s): s is Status => !!s)
})
const feedItems = computed(() => mixAdvertisements(
  statuses.value,
  advertisementsStore.advertisements,
  `deck:${meta.value.timelineType}`,
))

const newStatusCount = computed(() => timelinesStore.getNewStatusCount(meta.value.timelineType))
const hasNewPosts = computed(() => newStatusCount.value > 0)
const livePaused = computed(() => meta.value.streamKeys.some((k) => timelinesStore.isStreamPaused(k)))
const live = computed(
  () => !livePaused.value && meta.value.streamKeys.every((k) => timelinesStore.streamingClients.has(k)),
)

async function toggleLive() {
  if (livePaused.value) {
    // Resume: refetch first so posts missed while paused aren't skipped,
    // then fetchTimeline's auto-connect reopens every stream this feed uses
    await timelinesStore.fetchTimeline(meta.value.timelineType, { token: auth.token ?? undefined })
    meta.value.streamKeys.forEach((k) => timelinesStore.unpauseStream(k))
  } else {
    meta.value.streamKeys.forEach((k) => timelinesStore.pauseStream(k))
  }
}

const isAtTop = ref(true)
useTimelineStreamViewport('deck-column', () => meta.value.timelineType, isAtTop)

function handleScroll(event: Event) {
  isAtTop.value = (event.currentTarget as HTMLElement).scrollTop < 100
}

watch(newStatusCount, (len) => {
  if (len > 0 && isAtTop.value) {
    timelinesStore.showNewStatuses(meta.value.timelineType)
  }
})

function showNew() {
  timelinesStore.showNewStatuses(meta.value.timelineType)
}

async function loadTimeline() {
  await timelinesStore.fetchTimeline(meta.value.timelineType, { token: auth.token ?? undefined })
}

async function loadMore() {
  await timelinesStore.fetchMore(meta.value.timelineType, { token: auth.token ?? undefined })
}

watch(
  () => auth.token,
  (token) => {
    void advertisementsStore.load(token ?? undefined)
    void loadTimeline()
  },
  { immediate: true },
)

function navigate(status: Status) {
  void router.push(`/@${status.account.acct}/${status.id}`)
}
</script>

<template>
  <section
    class="flex h-full min-h-0 flex-none flex-col gap-2.5"
    :class="fluid ? 'w-full' : 'w-[392px] max-w-full'"
    :aria-label="title"
  >
    <!-- Column header -->
    <div class="dk-card flex flex-none items-center gap-2.5 rounded-[14px] px-3.5 py-2.5">
      <!-- Bound (not static) src: keeps Vue's asset transform from treating
           the same-origin URL as a module import at build time -->
      <img
        v-if="type === 'local'"
        :src="'/thumbnail.png'"
        alt=""
        class="h-[18px] w-[18px] flex-none rounded-[5px] object-contain"
        aria-hidden="true"
      />
      <span v-else class="text-base" aria-hidden="true">{{ meta.emoji }}</span>
      <span class="dk-mono dk-text text-[13.5px] font-semibold">{{ title }}</span>
      <span v-if="scope" class="dk-chip">{{ scope }}</span>
      <div class="flex-1" />
      <button
        v-if="auth.token"
        type="button"
        class="dk-live cursor-pointer border-0 bg-transparent p-0"
        :style="live ? '' : 'color: var(--dk-dim)'"
        :aria-pressed="live"
        :aria-label="t('deck.live_toggle')"
        :title="t('deck.live_toggle')"
        @click="toggleLive"
      >
        <span
          class="dk-dot !h-1.5 !w-1.5"
          :style="live ? '' : 'animation: none; background: var(--dk-dim)'"
          aria-hidden="true"
        />{{ t('deck.live') }}
      </button>
    </div>

    <!-- Column body -->
    <!-- overscroll-y only: horizontal trackpad swipes must chain up to the deck's x-scroller -->
    <div
      data-deck-scroll
      class="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-y-contain pb-1.5"
      @scroll.passive="handleScroll"
    >
      <button
        v-if="hasNewPosts"
        type="button"
        class="dk-pill-btn mb-2.5 w-full justify-center"
        style="color: var(--dk-acc); border-color: var(--dk-acc)"
        @click="showNew"
      >
        ↑ {{ t('timeline.new_posts', { count: newStatusCount }) }}
      </button>

      <div
        v-if="timeline.error"
        class="dk-card dk-dim-text mb-2.5 px-4 py-3 text-center text-[13px]"
        role="alert"
      >
        {{ timeline.error }}
      </div>

      <InfiniteScroll :loading="timeline.loading || timeline.loadingMore" :done="!timeline.hasMore" @load-more="loadMore">
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

          <div v-if="!timeline.loading && statuses.length === 0" class="dk-card dk-dim-text px-5 py-8 text-center text-[13.5px]">
            <p class="dk-text mb-1 font-semibold">{{ t('timeline.empty') }}</p>
            <p>{{ t('timeline.empty_hint') }}</p>
          </div>
        </div>
      </InfiniteScroll>
    </div>
  </section>
</template>
