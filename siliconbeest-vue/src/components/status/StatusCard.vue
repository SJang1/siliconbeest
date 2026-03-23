<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Status } from '@/types/mastodon'
import Avatar from '../common/Avatar.vue'
import StatusContent from './StatusContent.vue'
import StatusActions from './StatusActions.vue'
import MediaGallery from './MediaGallery.vue'

const { t } = useI18n()

const props = defineProps<{
  status: Status
}>()

const relativeTime = computed(() => {
  const date = new Date(props.status.created_at)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  if (diffMins < 1) return t('time.just_now')
  if (diffMins < 60) return t('time.minutes_ago', { n: diffMins })
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return t('time.hours_ago', { n: diffHours })
  const diffDays = Math.floor(diffHours / 24)
  return t('time.days_ago', { n: diffDays })
})
</script>

<template>
  <article
    class="px-4 py-3 border-b border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
    :aria-label="t('status.by', { name: status.account.display_name })"
  >
    <div class="flex gap-3">
      <!-- Avatar -->
      <router-link :to="`/@${status.account.acct}`" class="flex-shrink-0">
        <Avatar :src="status.account.avatar" :alt="status.account.display_name" size="md" />
      </router-link>

      <div class="flex-1 min-w-0">
        <!-- Header -->
        <div class="flex items-center gap-1 text-sm">
          <router-link :to="`/@${status.account.acct}`" class="font-bold hover:underline truncate">
            {{ status.account.display_name }}
          </router-link>
          <span class="text-gray-500 dark:text-gray-400 truncate">@{{ status.account.acct }}</span>
          <span class="text-gray-400 dark:text-gray-500 mx-1" aria-hidden="true">&middot;</span>
          <time :datetime="status.created_at" class="text-gray-500 dark:text-gray-400 text-xs whitespace-nowrap">
            {{ relativeTime }}
          </time>
        </div>

        <!-- Content -->
        <StatusContent
          :content="status.content"
          :spoiler-text="status.spoiler_text"
          :sensitive="status.sensitive"
        />

        <!-- Media -->
        <MediaGallery
          v-if="status.media_attachments?.length"
          :attachments="status.media_attachments"
          class="mt-2"
        />

        <!-- Actions -->
        <StatusActions
          :status-id="status.id"
          :replies-count="status.replies_count"
          :reblogs-count="status.reblogs_count"
          :favourites-count="status.favourites_count"
          :favourited="status.favourited"
          :reblogged="status.reblogged"
          :bookmarked="status.bookmarked"
          class="mt-2"
        />
      </div>
    </div>
  </article>
</template>
