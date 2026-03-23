<script setup lang="ts">
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

defineProps<{
  statusId: string
  repliesCount: number
  reblogsCount: number
  favouritesCount: number
  favourited?: boolean
  reblogged?: boolean
  bookmarked?: boolean
}>()

const emit = defineEmits<{
  reply: [id: string]
  reblog: [id: string]
  favourite: [id: string]
  bookmark: [id: string]
  share: [id: string]
}>()

function formatCount(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return n > 0 ? String(n) : ''
}
</script>

<template>
  <div class="flex items-center justify-between max-w-md -ml-2" role="group" :aria-label="t('status.actions')">
    <!-- Reply -->
    <button
      @click="emit('reply', statusId)"
      class="flex items-center gap-1 p-2 rounded-full text-gray-500 dark:text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-colors group"
      :aria-label="t('status.reply')"
    >
      <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3 10h10a5 5 0 015 5v3M3 10l4-4M3 10l4 4" /></svg>
      <span class="text-xs">{{ formatCount(repliesCount) }}</span>
    </button>

    <!-- Boost -->
    <button
      @click="emit('reblog', statusId)"
      class="flex items-center gap-1 p-2 rounded-full transition-colors group"
      :class="reblogged
        ? 'text-green-600 dark:text-green-400'
        : 'text-gray-500 dark:text-gray-400 hover:text-green-600 dark:hover:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/20'"
      :aria-label="t('status.boost')"
      :aria-pressed="reblogged"
    >
      <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
      <span class="text-xs">{{ formatCount(reblogsCount) }}</span>
    </button>

    <!-- Favourite -->
    <button
      @click="emit('favourite', statusId)"
      class="flex items-center gap-1 p-2 rounded-full transition-colors group"
      :class="favourited
        ? 'text-yellow-500 dark:text-yellow-400'
        : 'text-gray-500 dark:text-gray-400 hover:text-yellow-500 dark:hover:text-yellow-400 hover:bg-yellow-50 dark:hover:bg-yellow-900/20'"
      :aria-label="t('status.favourite')"
      :aria-pressed="favourited"
    >
      <svg class="w-5 h-5" :fill="favourited ? 'currentColor' : 'none'" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" /></svg>
      <span class="text-xs">{{ formatCount(favouritesCount) }}</span>
    </button>

    <!-- Bookmark -->
    <button
      @click="emit('bookmark', statusId)"
      class="flex items-center gap-1 p-2 rounded-full transition-colors group"
      :class="bookmarked
        ? 'text-indigo-600 dark:text-indigo-400'
        : 'text-gray-500 dark:text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20'"
      :aria-label="t('status.bookmark')"
      :aria-pressed="bookmarked"
    >
      <svg class="w-5 h-5" :fill="bookmarked ? 'currentColor' : 'none'" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" /></svg>
    </button>

    <!-- Share -->
    <button
      @click="emit('share', statusId)"
      class="p-2 rounded-full text-gray-500 dark:text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-colors"
      :aria-label="t('status.share')"
    >
      <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
    </button>
  </div>
</template>
