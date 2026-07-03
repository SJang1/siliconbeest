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
import type { DeckColumnKey } from '../composables/useDeckColumns'

const { t } = useI18n()
const router = useRouter()
const timelinesStore = useTimelinesStore()
const statusesStore = useStatusesStore()
const auth = useAuthStore()
const instanceStore = useInstanceStore()

const props = withDefaults(defineProps<{
  type: DeckColumnKey
  fluid?: boolean
}>(), {
  fluid: false,
})

const COLUMN_META: Record<DeckColumnKey, { emoji: string; timelineType: TimelineType; streamKey: string }> = {
  home: { emoji: '🏠', timelineType: 'home', streamKey: 'user' },
  local: { emoji: '🦬', timelineType: 'local', streamKey: 'public:local' },
  federated: { emoji: '📡', timelineType: 'public', streamKey: 'public' },
}

const meta = computed(() => COLUMN_META[props.type])
const title = computed(() => t(`deck.col_${props.type}`))
const scope = computed(() => {
  if (props.type === 'home') return t('deck.scope_following')
  if (props.type === 'local') return instanceStore.instance?.domain || ''
  return t('deck.scope_federated')
})

const timeline = computed(() => timelinesStore.getTimeline(meta.value.timelineType))

const statuses = computed(() => {
  return timeline.value.statusIds
    .map((id) => statusesStore.getCached(id))
    .filter((s): s is Status => !!s)
})

const hasNewPosts = computed(() => timeline.value.newStatusIds.length > 0)
const live = computed(() => timelinesStore.streamingClients.has(meta.value.streamKey))

const isAtTop = ref(true)

function handleScroll(event: Event) {
  isAtTop.value = (event.currentTarget as HTMLElement).scrollTop < 100
}

watch(() => timeline.value.newStatusIds.length, (len) => {
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
  () => {
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
      <span class="text-base" aria-hidden="true">{{ meta.emoji }}</span>
      <span class="dk-mono dk-text text-[13.5px] font-semibold">{{ title }}</span>
      <span v-if="scope" class="dk-chip">{{ scope }}</span>
      <div class="flex-1" />
      <span v-if="live" class="dk-live">
        <span class="dk-dot !h-1.5 !w-1.5" aria-hidden="true" />{{ t('deck.live') }}
      </span>
    </div>

    <!-- Column body -->
    <div
      class="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-1.5"
      @scroll.passive="handleScroll"
    >
      <button
        v-if="hasNewPosts"
        type="button"
        class="dk-pill-btn mb-2.5 w-full justify-center"
        style="color: var(--dk-acc); border-color: var(--dk-acc)"
        @click="showNew"
      >
        ↑ {{ t('timeline.new_posts', { count: timeline.newStatusIds.length }) }}
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
          <DeckStatusCard
            v-for="status in statuses"
            :key="status.id"
            :status="status"
            @navigate="navigate"
          />

          <div v-if="!timeline.loading && statuses.length === 0" class="dk-card dk-dim-text px-5 py-8 text-center text-[13.5px]">
            <p class="dk-text mb-1 font-semibold">{{ t('timeline.empty') }}</p>
            <p>{{ t('timeline.empty_hint') }}</p>
          </div>
        </div>
      </InfiniteScroll>
    </div>
  </section>
</template>
