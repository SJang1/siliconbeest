<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const props = defineProps<{
  statusId: string
  repliesCount: number
  reblogsCount: number
  favouritesCount: number
  favourited?: boolean
  reblogged?: boolean
  bookmarked?: boolean
  isOwnStatus?: boolean
  accountId?: string
  accountAcct?: string
  visibility?: string
  loadingReblog?: boolean
  loadingFavourite?: boolean
  loadingBookmark?: boolean
}>()

const canReblog = computed(() => {
  const v = props.visibility ?? 'public'
  return v === 'public' || v === 'unlisted'
})

const emit = defineEmits<{
  reply: [id: string]
  reblog: [id: string]
  favourite: [id: string]
  bookmark: [id: string]
  share: [id: string]
  edit: [id: string]
  delete: [id: string]
  report: [payload: { accountId: string; accountAcct: string; statusId: string }]
  block: [accountId: string]
  mute: [accountId: string]
}>()

const showMenu = ref(false)

function toggleMenu() {
  showMenu.value = !showMenu.value
}

function closeMenu() {
  showMenu.value = false
}

function handleEdit(id: string) {
  closeMenu()
  emit('edit', id)
}

function handleDelete(id: string) {
  closeMenu()
  emit('delete', id)
}

function handleReport() {
  closeMenu()
  if (props.accountId && props.accountAcct) {
    emit('report', { accountId: props.accountId, accountAcct: props.accountAcct, statusId: props.statusId })
  }
}

function handleBlock() {
  closeMenu()
  if (props.accountId) emit('block', props.accountId)
}

function handleMute() {
  closeMenu()
  if (props.accountId) emit('mute', props.accountId)
}

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
      @click="canReblog && !loadingReblog && emit('reblog', statusId)"
      :disabled="!canReblog || loadingReblog"
      class="flex items-center gap-1 p-2 rounded-full transition-colors group"
      :class="!canReblog
        ? 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
        : reblogged
          ? 'text-green-600 dark:text-green-400'
          : 'text-gray-500 dark:text-gray-400 hover:text-green-600 dark:hover:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/20'"
      :aria-label="canReblog ? t('status.boost') : t('status.cannot_boost')"
      :aria-pressed="reblogged"
      :title="!canReblog ? t('status.cannot_boost') : undefined"
    >
      <svg v-if="loadingReblog" class="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
      <svg v-else class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
      <span class="text-xs">{{ formatCount(reblogsCount) }}</span>
    </button>

    <!-- Favourite -->
    <button
      @click="!loadingFavourite && emit('favourite', statusId)"
      :disabled="loadingFavourite"
      class="flex items-center gap-1 p-2 rounded-full transition-colors group"
      :class="favourited
        ? 'text-yellow-500 dark:text-yellow-400'
        : 'text-gray-500 dark:text-gray-400 hover:text-yellow-500 dark:hover:text-yellow-400 hover:bg-yellow-50 dark:hover:bg-yellow-900/20'"
      :aria-label="t('status.favourite')"
      :aria-pressed="favourited"
    >
      <svg v-if="loadingFavourite" class="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
      <svg v-else class="w-5 h-5" :fill="favourited ? 'currentColor' : 'none'" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" /></svg>
      <span class="text-xs">{{ formatCount(favouritesCount) }}</span>
    </button>

    <!-- Bookmark -->
    <button
      @click="!loadingBookmark && emit('bookmark', statusId)"
      :disabled="loadingBookmark"
      class="flex items-center gap-1 p-2 rounded-full transition-colors group"
      :class="bookmarked
        ? 'text-indigo-600 dark:text-indigo-400'
        : 'text-gray-500 dark:text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20'"
      :aria-label="t('status.bookmark')"
      :aria-pressed="bookmarked"
    >
      <svg v-if="loadingBookmark" class="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
      <svg v-else class="w-5 h-5" :fill="bookmarked ? 'currentColor' : 'none'" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" /></svg>
    </button>

    <!-- Share -->
    <button
      @click="emit('share', statusId)"
      class="p-2 rounded-full text-gray-500 dark:text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-colors"
      :aria-label="t('status.share')"
    >
      <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
    </button>

    <!-- More menu -->
    <div class="relative">
      <button
        @click="toggleMenu"
        class="p-2 rounded-full text-gray-500 dark:text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-colors"
        :aria-label="t('status.more_actions')"
      >
        <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="12" cy="19" r="1.5" /></svg>
      </button>

      <!-- Dropdown -->
      <div
        v-if="showMenu"
        class="absolute right-0 bottom-full mb-1 w-40 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50 py-1"
      >
        <div class="fixed inset-0 z-[-1]" @click="closeMenu" />
        <button
          v-if="isOwnStatus"
          @click="handleEdit(statusId)"
          class="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
          {{ t('status.edit') }}
        </button>
        <button
          v-if="isOwnStatus"
          @click="handleDelete(statusId)"
          class="w-full text-left px-4 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
          {{ t('status.delete_action') }}
        </button>
        <button
          v-if="!isOwnStatus"
          @click="handleMute"
          class="w-full text-left px-4 py-2 text-sm text-orange-600 dark:text-orange-400 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" /></svg>
          {{ t('account.mute') }}
        </button>
        <button
          v-if="!isOwnStatus"
          @click="handleBlock"
          class="w-full text-left px-4 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" /></svg>
          {{ t('account.block') }}
        </button>
        <button
          v-if="!isOwnStatus"
          @click="handleReport"
          class="w-full text-left px-4 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3 21v-4m0 0V5a2 2 0 012-2h6.5l1 1H21l-3 6 3 6h-8.5l-1-1H5a2 2 0 00-2 2z" /></svg>
          {{ t('status.report') }}
        </button>
      </div>
    </div>
  </div>
</template>
