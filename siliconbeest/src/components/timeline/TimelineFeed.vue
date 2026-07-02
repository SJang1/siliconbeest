<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Status } from '@/types/mastodon'
import InfiniteScroll from '../common/InfiniteScroll.vue'
import StatusCard from '../status/StatusCard.vue'

const { t } = useI18n()

const props = defineProps<{
  statuses: Status[]
  loading?: boolean
  done?: boolean
  hasNewPosts?: boolean
  newPostsCount?: number
  autoInsert?: boolean
}>()

const emit = defineEmits<{
  'load-more': []
  'load-new': []
  'navigate': [status: Status]
}>()
</script>

<template>
  <div>
    <!-- New posts banner -->
    <button
      v-if="hasNewPosts"
      @click="emit('load-new')"
      class="inline-flex w-full items-center justify-center gap-1.5 border-b border-outline bg-brand-50/80 py-3 text-center text-sm font-semibold text-brand-700 transition-colors hover:bg-brand-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-400 dark:border-outline-dark dark:bg-brand-950/40 dark:text-brand-300 dark:hover:bg-brand-950/60"
    >
      <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 10.5 12 3m0 0 7.5 7.5M12 3v18" />
      </svg>
      {{ t('timeline.new_posts', { count: props.newPostsCount ?? 0 }) }}
    </button>

    <InfiniteScroll :loading="loading" :done="done" @load-more="emit('load-more')">
      <StatusCard
        v-for="status in statuses"
        :key="status.id"
        :status="status"
        @navigate="(s: Status) => emit('navigate', s)"
      />

      <!-- Empty state -->
      <div v-if="!loading && statuses.length === 0" class="sb-empty px-6">
        <div class="flex h-12 w-12 items-center justify-center rounded-full bg-brand-50 text-brand-500 dark:bg-brand-950/50 dark:text-brand-300" aria-hidden="true">
          <svg class="h-6 w-6" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M2.25 13.5h3.86a2.25 2.25 0 0 1 2.012 1.244l.256.512a2.25 2.25 0 0 0 2.013 1.244h3.218a2.25 2.25 0 0 0 2.013-1.244l.256-.512a2.25 2.25 0 0 1 2.013-1.244h3.859m-19.5.338V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18v-4.162c0-.224-.034-.447-.1-.661L19.24 5.338a2.25 2.25 0 0 0-2.15-1.588H6.911a2.25 2.25 0 0 0-2.15 1.588L2.35 13.177a2.25 2.25 0 0 0-.1.661Z" />
          </svg>
        </div>
        <p class="sb-heading text-lg text-slate-700 dark:text-slate-200">{{ t('timeline.empty') }}</p>
        <p>{{ t('timeline.empty_hint') }}</p>
      </div>
    </InfiniteScroll>
  </div>
</template>
