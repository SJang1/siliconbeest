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
}>()
</script>

<template>
  <div>
    <!-- New posts banner -->
    <button
      v-if="hasNewPosts && !autoInsert"
      @click="emit('load-new')"
      class="w-full py-3 text-center text-sm font-semibold text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-900/20 hover:bg-indigo-100 dark:hover:bg-indigo-900/30 border-b border-gray-200 dark:border-gray-700 transition-colors"
    >
      {{ t('timeline.new_posts', { count: props.newPostsCount ?? 0 }) }}
    </button>

    <InfiniteScroll :loading="loading" :done="done" @load-more="emit('load-more')">
      <StatusCard
        v-for="status in statuses"
        :key="status.id"
        :status="status"
      />

      <!-- Empty state -->
      <div v-if="!loading && statuses.length === 0" class="p-8 text-center text-gray-500 dark:text-gray-400">
        <p class="text-lg font-medium">{{ t('timeline.empty') }}</p>
        <p class="text-sm mt-1">{{ t('timeline.empty_hint') }}</p>
      </div>
    </InfiniteScroll>
  </div>
</template>
