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
  quotePolicyAllows?: boolean
  quotePolicyReason?: string | null
  loadingReblog?: boolean
  loadingFavourite?: boolean
  loadingBookmark?: boolean
}>()

const canReblog = computed(() => {
  const v = props.visibility ?? 'public'
  return v === 'public' || v === 'unlisted'
})

const canQuote = computed(() => {
  const v = props.visibility ?? 'public'
  return (v === 'public' || v === 'unlisted') && props.quotePolicyAllows !== false
})

const quoteTooltip = computed(() => {
  if (canQuote.value) return t('status.quote')
  const reason = props.quotePolicyReason
  if (reason === 'policy_nobody') return t('status.cannot_quote_policy_nobody')
  if (reason === 'followers_only') return t('status.cannot_quote_followers_only')
  if (reason === 'following_only') return t('status.cannot_quote_following_only')
  if (reason === 'login_required') return t('status.cannot_quote_login_required')
  return t('status.cannot_quote_visibility')
})

const emit = defineEmits<{
  reply: [id: string]
  reblog: [id: string]
  quote: [id: string]
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

function onMenuFocusOut(e: FocusEvent) {
  const container = e.currentTarget as HTMLElement
  if (!container?.contains(e.relatedTarget as Node)) {
    closeMenu()
  }
}

function formatCount(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return n > 0 ? String(n) : ''
}
</script>

<template>
  <div class="-ml-2 flex max-w-md items-center justify-between" role="group" :aria-label="t('status.actions')">
    <!-- Reply -->
    <button
      @click="emit('reply', statusId)"
      class="group flex items-center gap-1.5 rounded-full p-2 text-slate-500 transition-colors duration-150 hover:bg-brand-50 hover:text-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 dark:text-slate-400 dark:hover:bg-brand-500/10 dark:hover:text-brand-400"
      :aria-label="t('status.reply')"
    >
      <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" /></svg>
      <span class="text-xs font-medium tabular-nums">{{ formatCount(repliesCount) }}</span>
    </button>

    <!-- Boost -->
    <button
      @click="canReblog && !loadingReblog && emit('reblog', statusId)"
      :disabled="!canReblog || loadingReblog"
      class="group flex items-center gap-1.5 rounded-full p-2 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
      :class="!canReblog
        ? 'cursor-not-allowed text-slate-300 dark:text-slate-600'
        : reblogged
          ? 'text-green-600 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-500/10'
          : 'text-slate-500 dark:text-slate-400 hover:bg-green-50 hover:text-green-600 dark:hover:bg-green-500/10 dark:hover:text-green-400'"
      :aria-label="canReblog ? t('status.boost') : t('status.cannot_boost')"
      :aria-pressed="reblogged"
      :title="!canReblog ? t('status.cannot_boost') : undefined"
    >
      <svg v-if="loadingReblog" class="h-5 w-5 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
      <svg v-else class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M19.5 12c0-1.232-.046-2.453-.138-3.662a4.006 4.006 0 00-3.7-3.7 48.678 48.678 0 00-7.324 0 4.006 4.006 0 00-3.7 3.7c-.017.22-.032.441-.046.662M19.5 12l3-3m-3 3l-3-3m-12 3c0 1.232.046 2.453.138 3.662a4.006 4.006 0 003.7 3.7 48.656 48.656 0 007.324 0 4.006 4.006 0 003.7-3.7c.017-.22.032-.441.046-.662M4.5 12l-3 3m3-3l3 3" /></svg>
      <span class="text-xs font-medium tabular-nums">{{ formatCount(reblogsCount) }}</span>
    </button>

    <!-- Quote -->
    <button
      @click="canQuote && emit('quote', statusId)"
      :disabled="!canQuote"
      class="group flex items-center gap-1.5 rounded-full p-2 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
      :class="canQuote
        ? 'text-slate-500 dark:text-slate-400 hover:bg-violet-50 hover:text-violet-600 dark:hover:bg-violet-500/10 dark:hover:text-violet-400'
        : 'cursor-not-allowed text-slate-300 dark:text-slate-600'"
      :aria-label="quoteTooltip"
      :title="quoteTooltip"
    >
      <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.184-4.183a1.14 1.14 0 01.778-.332 48.294 48.294 0 005.83-.498c1.585-.233 2.708-1.626 2.708-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" /></svg>
    </button>

    <!-- Favourite -->
    <button
      @click="!loadingFavourite && emit('favourite', statusId)"
      :disabled="loadingFavourite"
      class="group flex items-center gap-1.5 rounded-full p-2 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
      :class="favourited
        ? 'text-rose-500 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-500/10'
        : 'text-slate-500 dark:text-slate-400 hover:bg-rose-50 hover:text-rose-500 dark:hover:bg-rose-500/10 dark:hover:text-rose-400'"
      :aria-label="t('status.favourite')"
      :aria-pressed="favourited"
    >
      <svg v-if="loadingFavourite" class="h-5 w-5 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
      <svg v-else class="h-5 w-5" :fill="favourited ? 'currentColor' : 'none'" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.562.562 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" /></svg>
      <span class="text-xs font-medium tabular-nums">{{ formatCount(favouritesCount) }}</span>
    </button>

    <!-- Bookmark -->
    <button
      @click="!loadingBookmark && emit('bookmark', statusId)"
      :disabled="loadingBookmark"
      class="group flex items-center gap-1.5 rounded-full p-2 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
      :class="bookmarked
        ? 'text-amber-500 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-500/10'
        : 'text-slate-500 dark:text-slate-400 hover:bg-amber-50 hover:text-amber-500 dark:hover:bg-amber-500/10 dark:hover:text-amber-400'"
      :aria-label="t('status.bookmark')"
      :aria-pressed="bookmarked"
    >
      <svg v-if="loadingBookmark" class="h-5 w-5 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
      <svg v-else class="h-5 w-5" :fill="bookmarked ? 'currentColor' : 'none'" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M17.593 3.322c.1.128.157.29.157.478V21L12 17.25 6.25 21V3.8c0-.187.057-.35.157-.478A48.62 48.62 0 0112 3c1.968 0 3.9.128 5.593.322z" /></svg>
    </button>

    <!-- Share -->
    <button
      @click="emit('share', statusId)"
      class="rounded-full p-2 text-slate-500 transition-colors duration-150 hover:bg-brand-50 hover:text-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 dark:text-slate-400 dark:hover:bg-brand-500/10 dark:hover:text-brand-400"
      :aria-label="t('status.share')"
    >
      <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" /></svg>
    </button>

    <!-- More menu -->
    <div class="relative" @focusout="onMenuFocusOut">
      <button
        @click="toggleMenu"
        class="rounded-full p-2 text-slate-500 transition-colors duration-150 hover:bg-brand-50 hover:text-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 dark:text-slate-400 dark:hover:bg-brand-500/10 dark:hover:text-brand-400"
        :aria-label="t('status.more_actions')"
      >
        <svg class="h-5 w-5" fill="currentColor" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></svg>
      </button>

      <!-- Dropdown -->
      <div
        v-if="showMenu"
        class="sb-menu absolute bottom-full right-0 z-50 mb-1.5 w-44 animate-fade-in"
      >
        <button
          v-if="isOwnStatus"
          @click="handleEdit(statusId)"
          class="sb-menu-item"
        >
          <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" /></svg>
          {{ t('status.edit') }}
        </button>
        <button
          v-if="isOwnStatus"
          @click="handleDelete(statusId)"
          class="sb-menu-item text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10"
        >
          <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" /></svg>
          {{ t('status.delete_action') }}
        </button>
        <button
          v-if="!isOwnStatus"
          @click="handleMute"
          class="sb-menu-item text-amber-600 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-500/10"
        >
          <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M17.25 9.75L19.5 12m0 0l2.25 2.25M19.5 12l2.25-2.25M19.5 12l-2.25 2.25m-10.5-6l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" /></svg>
          {{ t('account.mute') }}
        </button>
        <button
          v-if="!isOwnStatus"
          @click="handleBlock"
          class="sb-menu-item text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10"
        >
          <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" /></svg>
          {{ t('account.block') }}
        </button>
        <button
          v-if="!isOwnStatus"
          @click="handleReport"
          class="sb-menu-item text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10"
        >
          <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3 3v1.5M3 21v-6m0 0l2.77-.693a9 9 0 016.208.682l.108.054a9 9 0 006.086.71l3.114-.732a48.524 48.524 0 01-.005-10.499l-3.11.732a9 9 0 01-6.085-.711l-.108-.054a9 9 0 00-6.208-.682L3 4.5M3 15V4.5" /></svg>
          {{ t('status.report') }}
        </button>
      </div>
    </div>
  </div>
</template>
