<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTimelinesStore } from '@/stores/timelines'
import { useStatusesStore } from '@/stores/statuses'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'
import { useRecommendedTimelineFeature } from '@/composables/useRecommendedTimelineFeature'
import type { Status } from '@/types/mastodon'
import TimelineFeed from './TimelineFeed.vue'
import ThreadView from './ThreadView.vue'

const { t } = useI18n()
const timelinesStore = useTimelinesStore()
const statusesStore = useStatusesStore()
const auth = useAuthStore()
const ui = useUiStore()
const { available } = useRecommendedTimelineFeature()

const activeView = ref<'timeline' | 'thread'>('timeline')
const threadStatusId = ref<string | null>(null)
const timeline = computed(() => timelinesStore.getTimeline('recommended'))
const statuses = computed(() => timeline.value.statusIds
  .map(id => statusesStore.getCached(id))
  .filter((status): status is Status => !!status))

function openThread(status: Status) {
  threadStatusId.value = status.id
  activeView.value = 'thread'
}

function backToTimeline() {
  activeView.value = 'timeline'
  threadStatusId.value = null
}

async function refreshRecommended() {
  if (!auth.token || !available.value) return
  await timelinesStore.refreshRecommendedTimeline(auth.token)
}

async function loadMore() {
  if (!auth.token || !available.value) return
  await timelinesStore.fetchMore('recommended', { token: auth.token })
}

watch(
  [() => auth.token, available],
  ([token, enabled], [previousToken, wasEnabled] = [null, false]) => {
    if (token && enabled && (token !== previousToken || !wasEnabled)) {
      void refreshRecommended()
    }
  },
  { immediate: true },
)
</script>

<template>
  <div data-status-scroll class="h-full min-h-0 overflow-y-auto overscroll-contain">
    <template v-if="activeView === 'timeline'">
      <header class="sb-glass sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div class="min-w-0">
          <h1 class="sb-heading truncate text-lg">✨ {{ t('timeline.ai_recommended') }}</h1>
        </div>
        <div class="flex items-center gap-2">
          <button
            type="button"
            class="sb-btn sb-btn-secondary sb-btn-sm"
            :disabled="timeline.loading || timeline.loadingMore"
            :aria-label="t('timeline.refresh_recommended')"
            @click="refreshRecommended"
          >
            {{ timeline.loading
              ? t('timeline.refreshing_recommended')
              : t('timeline.refresh_recommended') }}
          </button>
          <button
            v-if="auth.isAuthenticated"
            type="button"
            class="sb-btn sb-btn-primary sb-btn-sm"
            @click="ui.openComposeModal()"
          >
            {{ t('nav.compose') }}
          </button>
        </div>
      </header>

      <div
        v-if="timeline.error"
        class="mx-4 my-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-center text-sm text-red-600 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-400"
        role="alert"
      >
        <p class="font-semibold">{{ t('timeline.recommended_failed') }}</p>
        <p class="mt-1 whitespace-pre-line break-words">
          {{ t('timeline.recommended_failure_reason', { reason: timeline.error }) }}
        </p>
        <button
          type="button"
          class="mt-2 rounded-full border border-red-300 px-3 py-1 text-xs font-semibold hover:bg-red-100 dark:border-red-800 dark:hover:bg-red-950/50"
          :disabled="timeline.loading || timeline.loadingMore"
          @click="refreshRecommended"
        >
          {{ t('timeline.refresh_recommended') }}
        </button>
      </div>

      <TimelineFeed
        v-if="!timeline.error || statuses.length > 0"
        :statuses="statuses"
        timeline-key="recommended"
        show-advertisements
        :loading="timeline.loading || timeline.loadingMore"
        :done="!timeline.hasMore"
        :has-new-posts="false"
        :new-posts-count="0"
        @load-more="loadMore"
        @navigate="openThread"
      />
    </template>

    <ThreadView
      v-else-if="threadStatusId"
      :status-id="threadStatusId"
      @back="backToTimeline"
      @navigate="openThread"
    />
  </div>
</template>
