<script setup lang="ts">
import { ref, computed, nextTick, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { getStatusActionPermissions } from '@/utils/permissions'
import { shouldOpenMenuDown } from '@/utils/menuPlacement'
import { useActionMenuCoordinator } from '@/composables/useActionMenuCoordinator'

const { t } = useI18n()

const props = defineProps<{
  statusId: string
  repliesCount: number
  reblogsCount: number
  favouritesCount: number
  favourited?: boolean
  reblogged?: boolean
  bookmarked?: boolean
  accountCanAct?: boolean
  viewerAuthenticated?: boolean
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

const permissions = computed(() => getStatusActionPermissions({
  accountCanAct: props.accountCanAct === true,
  isOwnStatus: props.isOwnStatus === true,
  visibility: props.visibility,
  quotePolicyAllows: props.quotePolicyAllows,
}))

const canReblog = computed(() => permissions.value.reblog)
const canQuote = computed(() => permissions.value.quote)

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
  viewReblogs: [id: string]
  viewFavourites: [id: string]
  react: [id: string, anchor?: HTMLElement]
  bookmark: [id: string]
  share: [id: string]
  edit: [id: string]
  delete: [id: string]
  report: [payload: { accountId: string; accountAcct: string; statusId: string }]
  block: [accountId: string]
  mute: [accountId: string]
  overlay: [open: boolean]
}>()

const showMenu = ref(false)
// Consolidated dropdowns: boost+quote and favourite+emoji-reaction
const showBoostMenu = ref(false)
const showFavMenu = ref(false)
// Anchor for the emoji-reaction picker (teleported to body)
const boostBtnRef = ref<HTMLElement | null>(null)
const favBtnRef = ref<HTMLElement | null>(null)
const moreBtnRef = ref<HTMLElement | null>(null)
const boostMenuRef = ref<HTMLElement | null>(null)
const favMenuRef = ref<HTMLElement | null>(null)
const moreMenuRef = ref<HTMLElement | null>(null)
const menuOpensDown = ref(false)
const menuCoordinator = useActionMenuCoordinator(() => closeAllMenus())
const anyMenuOpen = computed(() => showMenu.value || showBoostMenu.value || showFavMenu.value)

watch(anyMenuOpen, (open) => emit('overlay', open))

function closeAllMenus() {
  showMenu.value = false
  showBoostMenu.value = false
  showFavMenu.value = false
  menuCoordinator.release()
}

async function toggleMenu() {
  const next = !showMenu.value
  closeAllMenus()
  showMenu.value = next
  if (next) {
    menuCoordinator.claim()
    await nextTick()
    menuOpensDown.value = shouldOpenMenuDown(moreBtnRef.value, moreMenuRef.value)
  }
}

async function toggleBoostMenu() {
  const next = !showBoostMenu.value
  closeAllMenus()
  showBoostMenu.value = next
  if (next) {
    menuCoordinator.claim()
    await nextTick()
    menuOpensDown.value = shouldOpenMenuDown(boostBtnRef.value, boostMenuRef.value)
  }
}

async function toggleFavMenu() {
  const next = !showFavMenu.value
  closeAllMenus()
  showFavMenu.value = next
  if (next) {
    menuCoordinator.claim()
    await nextTick()
    menuOpensDown.value = shouldOpenMenuDown(favBtnRef.value, favMenuRef.value)
  }
}

function closeMenu() {
  showMenu.value = false
  menuCoordinator.release()
}

function handleBoost() {
  showBoostMenu.value = false
  menuCoordinator.release()
  if (canReblog.value && !props.loadingReblog) emit('reblog', props.statusId)
}

function handleQuoteItem() {
  showBoostMenu.value = false
  menuCoordinator.release()
  if (canQuote.value) emit('quote', props.statusId)
}

function handleFavouriteItem() {
  showFavMenu.value = false
  menuCoordinator.release()
  if (permissions.value.favourite && !props.loadingFavourite) emit('favourite', props.statusId)
}

function handleReact() {
  showFavMenu.value = false
  menuCoordinator.release()
  if (permissions.value.react) emit('react', props.statusId, favBtnRef.value ?? undefined)
}

function handleEdit(id: string) {
  closeMenu()
  if (permissions.value.edit) emit('edit', id)
}

function handleDelete(id: string) {
  closeMenu()
  if (permissions.value.delete) emit('delete', id)
}

function handleReport() {
  closeMenu()
  if (permissions.value.report && props.accountId && props.accountAcct) {
    emit('report', { accountId: props.accountId, accountAcct: props.accountAcct, statusId: props.statusId })
  }
}

function handleBlock() {
  closeMenu()
  if (permissions.value.block && props.accountId) emit('block', props.accountId)
}

function handleMute() {
  closeMenu()
  if (permissions.value.mute && props.accountId) emit('mute', props.accountId)
}

function onMenuFocusOut(e: FocusEvent) {
  const container = e.currentTarget as HTMLElement
  if (!container?.contains(e.relatedTarget as Node)) {
    closeMenu()
  }
}

function onBoostFocusOut(e: FocusEvent) {
  const container = e.currentTarget as HTMLElement
  if (!container?.contains(e.relatedTarget as Node)) {
    showBoostMenu.value = false
    menuCoordinator.release()
  }
}

function onFavFocusOut(e: FocusEvent) {
  const container = e.currentTarget as HTMLElement
  if (!container?.contains(e.relatedTarget as Node)) {
    showFavMenu.value = false
    menuCoordinator.release()
  }
}

function formatCount(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return n > 0 ? String(n) : ''
}
</script>

<template>
  <div class="-ml-2 flex flex-wrap items-center justify-between gap-y-1 sm:max-w-lg sm:flex-nowrap" role="group" :aria-label="t('status.actions')">
    <!-- Reply -->
    <button
      data-test="reply-action"
      @click="permissions.reply && emit('reply', statusId)"
      :disabled="!permissions.reply"
      class="group flex min-h-11 touch-manipulation items-center gap-1.5 rounded-full p-2.5 text-slate-500 transition-colors duration-150 hover:bg-brand-50 hover:text-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 dark:text-slate-400 dark:hover:bg-brand-500/10 dark:hover:text-brand-400"
      :aria-label="t('status.reply')"
    >
      <svg class="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" /></svg>
      <span class="text-sm font-semibold tabular-nums">{{ formatCount(repliesCount) }}</span>
    </button>

    <!-- Boost / Quote (consolidated menu) -->
    <div class="relative flex items-center" @focusout="onBoostFocusOut">
      <button
        ref="boostBtnRef"
        data-test="reblog-action"
        @click="toggleBoostMenu"
        :disabled="!canReblog && !canQuote"
        class="group flex min-h-11 min-w-11 touch-manipulation items-center justify-center rounded-full p-2.5 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
        :class="!canReblog && !canQuote
          ? 'cursor-not-allowed text-slate-300 dark:text-slate-600'
          : reblogged
            ? 'text-green-600 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-500/10'
            : 'text-slate-500 dark:text-slate-400 hover:bg-green-50 hover:text-green-600 dark:hover:bg-green-500/10 dark:hover:text-green-400'"
        :aria-label="canReblog ? t('status.boost') : t('status.cannot_boost')"
        :aria-pressed="reblogged"
        aria-haspopup="menu"
        :aria-expanded="showBoostMenu"
        :title="!canReblog && !canQuote ? t('status.cannot_boost') : undefined"
      >
        <svg v-if="loadingReblog" class="h-6 w-6 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
        <svg v-else class="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M19.5 12c0-1.232-.046-2.453-.138-3.662a4.006 4.006 0 00-3.7-3.7 48.678 48.678 0 00-7.324 0 4.006 4.006 0 00-3.7 3.7c-.017.22-.032.441-.046.662M19.5 12l3-3m-3 3l-3-3m-12 3c0 1.232.046 2.453.138 3.662a4.006 4.006 0 003.7 3.7 48.656 48.656 0 007.324 0 4.006 4.006 0 003.7-3.7c.017-.22.032-.441.046-.662M4.5 12l-3 3m3-3l3 3" /></svg>
      </button>

      <button
        v-if="viewerAuthenticated && reblogsCount > 0"
        data-test="reblogs-count"
        type="button"
        class="-ml-2 min-h-11 rounded-full px-2 text-sm font-semibold tabular-nums text-slate-600 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 dark:text-slate-300"
        :aria-label="t('status.view_reblogs', { count: reblogsCount })"
        aria-haspopup="dialog"
        @click.stop="emit('viewReblogs', statusId)"
      >
        {{ formatCount(reblogsCount) }}
      </button>
      <span v-else-if="reblogsCount > 0" class="-ml-2 px-2 text-sm font-semibold tabular-nums text-slate-500 dark:text-slate-400">
        <span aria-hidden="true">{{ formatCount(reblogsCount) }}</span>
        <span class="sr-only">{{ t('status.reblogs_count', { count: reblogsCount }) }}</span>
      </span>

      <div
        v-if="showBoostMenu"
        ref="boostMenuRef"
        class="sb-menu absolute left-0 z-50 w-48 animate-fade-in"
        :class="menuOpensDown ? 'top-full mt-1.5' : 'bottom-full mb-1.5'"
        role="menu"
      >
        <button
          @click="handleBoost"
          :disabled="!canReblog || loadingReblog"
          class="sb-menu-item py-2.5"
          :class="!canReblog
            ? 'cursor-not-allowed text-slate-300 dark:text-slate-600'
            : reblogged ? 'text-green-600 dark:text-green-400' : ''"
          role="menuitem"
          :title="!canReblog ? t('status.cannot_boost') : undefined"
        >
          <svg class="h-5 w-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" /></svg>
          {{ reblogged ? t('status.unboost') : t('status.boost') }}
        </button>
        <button
          @click="handleQuoteItem"
          :disabled="!canQuote"
          class="sb-menu-item py-2.5"
          :class="!canQuote ? 'cursor-not-allowed text-slate-300 dark:text-slate-600' : ''"
          role="menuitem"
          :title="quoteTooltip"
        >
          <svg class="h-5 w-5 shrink-0" fill="currentColor" viewBox="0 0 16 16" aria-hidden="true"><path d="M12 12a1 1 0 0 0 1-1V8.558a1 1 0 0 0-1-1h-1.388q0-.527.062-1.054.093-.558.31-.992t.559-.683q.34-.279.868-.279V3q-.868 0-1.52.372a3.3 3.3 0 0 0-1.085.992 4.9 4.9 0 0 0-.62 1.458A7.7 7.7 0 0 0 9 7.558V11a1 1 0 0 0 1 1zm-6 0a1 1 0 0 0 1-1V8.558a1 1 0 0 0-1-1H4.612q0-.527.062-1.054.094-.558.31-.992.217-.434.559-.683.34-.279.868-.279V3q-.868 0-1.52.372a3.3 3.3 0 0 0-1.085.992 4.9 4.9 0 0 0-.62 1.458A7.7 7.7 0 0 0 3 7.558V11a1 1 0 0 0 1 1z"/></svg>
          {{ t('status.quote') }}
        </button>
      </div>
    </div>

    <!-- Favourite / Emoji reaction (consolidated menu) -->
    <div class="relative flex items-center" @focusout="onFavFocusOut">
      <button
        ref="favBtnRef"
        data-test="favourite-action"
        @click="toggleFavMenu"
        :disabled="!permissions.favourite && !permissions.react"
        class="group flex min-h-11 min-w-11 touch-manipulation items-center justify-center rounded-full p-2.5 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
        :class="!permissions.favourite && !permissions.react
          ? 'cursor-not-allowed text-slate-300 dark:text-slate-600'
          : favourited
          ? 'text-rose-500 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-500/10'
          : 'text-slate-500 dark:text-slate-400 hover:bg-rose-50 hover:text-rose-500 dark:hover:bg-rose-500/10 dark:hover:text-rose-400'"
        :aria-label="t('status.favourite')"
        :aria-pressed="favourited"
        aria-haspopup="menu"
        :aria-expanded="showFavMenu"
      >
        <svg v-if="loadingFavourite" class="h-6 w-6 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
        <svg v-else class="h-6 w-6" :fill="favourited ? 'currentColor' : 'none'" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.562.562 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" /></svg>
      </button>

      <button
        v-if="viewerAuthenticated && favouritesCount > 0"
        data-test="favourites-count"
        type="button"
        class="-ml-2 min-h-11 rounded-full px-2 text-sm font-semibold tabular-nums text-slate-600 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 dark:text-slate-300"
        :aria-label="t('status.view_favourites', { count: favouritesCount })"
        aria-haspopup="dialog"
        @click.stop="emit('viewFavourites', statusId)"
      >
        {{ formatCount(favouritesCount) }}
      </button>
      <span v-else-if="favouritesCount > 0" class="-ml-2 px-2 text-sm font-semibold tabular-nums text-slate-500 dark:text-slate-400">
        <span aria-hidden="true">{{ formatCount(favouritesCount) }}</span>
        <span class="sr-only">{{ t('status.favourites_count', { count: favouritesCount }) }}</span>
      </span>

      <div
        v-if="showFavMenu"
        ref="favMenuRef"
        class="sb-menu absolute left-1/2 z-50 w-48 -translate-x-1/2 animate-fade-in"
        :class="menuOpensDown ? 'top-full mt-1.5' : 'bottom-full mb-1.5'"
        role="menu"
      >
        <button
          @click="handleFavouriteItem"
          :disabled="!permissions.favourite || loadingFavourite"
          class="sb-menu-item py-2.5"
          :class="favourited ? 'text-rose-500 dark:text-rose-400' : ''"
          role="menuitem"
        >
          <svg class="h-5 w-5 shrink-0" :fill="favourited ? 'currentColor' : 'none'" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.562.562 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" /></svg>
          {{ favourited ? t('status.unfavourite') : t('status.favourite') }}
        </button>
        <button
          @click="handleReact"
          :disabled="!permissions.react"
          class="sb-menu-item py-2.5"
          role="menuitem"
        >
          <svg class="h-5 w-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M15.182 15.182a4.5 4.5 0 01-6.364 0M21 12a9 9 0 11-18 0 9 9 0 0118 0zM9.75 9.75c0 .414-.168.75-.375.75S9 10.164 9 9.75 9.168 9 9.375 9s.375.336.375.75zm-.375 0h.008v.015h-.008V9.75zm5.625 0c0 .414-.168.75-.375.75s-.375-.336-.375-.75.168-.75.375-.75.375.336.375.75zm-.375 0h.008v.015h-.008V9.75z" /></svg>
          {{ t('status.react') }}
        </button>
      </div>
    </div>

    <!-- Bookmark -->
    <button
      data-test="bookmark-action"
      @click="permissions.bookmark && !loadingBookmark && emit('bookmark', statusId)"
      :disabled="!permissions.bookmark || loadingBookmark"
      class="group flex touch-manipulation items-center gap-1.5 rounded-full p-2 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
      :class="!permissions.bookmark
        ? 'cursor-not-allowed text-slate-300 dark:text-slate-600'
        : bookmarked
        ? 'text-amber-500 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-500/10'
        : 'text-slate-500 dark:text-slate-400 hover:bg-amber-50 hover:text-amber-500 dark:hover:bg-amber-500/10 dark:hover:text-amber-400'"
      :aria-label="t('status.bookmark')"
      :aria-pressed="bookmarked"
    >
      <svg v-if="loadingBookmark" class="h-6 w-6 animate-spin sm:h-5 sm:w-5" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
      <svg v-else class="h-6 w-6 sm:h-5 sm:w-5" :fill="bookmarked ? 'currentColor' : 'none'" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M17.593 3.322c.1.128.157.29.157.478V21L12 17.25 6.25 21V3.8c0-.187.057-.35.157-.478A48.62 48.62 0 0112 3c1.968 0 3.9.128 5.593.322z" /></svg>
    </button>

    <!-- Share -->
    <button
      data-test="share-action"
      @click="permissions.share && emit('share', statusId)"
      :disabled="!permissions.share"
      class="touch-manipulation rounded-full p-2 text-slate-500 transition-colors duration-150 hover:bg-brand-50 hover:text-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 dark:text-slate-400 dark:hover:bg-brand-500/10 dark:hover:text-brand-400"
      :aria-label="t('status.share')"
    >
      <svg class="h-6 w-6 sm:h-5 sm:w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" /></svg>
    </button>

    <!-- More menu -->
    <div
      v-if="permissions.edit || permissions.delete || permissions.report || permissions.block || permissions.mute"
      class="relative"
      @focusout="onMenuFocusOut"
    >
      <button
        ref="moreBtnRef"
        data-test="more-action"
        @click="toggleMenu"
        class="touch-manipulation rounded-full p-2 text-slate-500 transition-colors duration-150 hover:bg-brand-50 hover:text-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 dark:text-slate-400 dark:hover:bg-brand-500/10 dark:hover:text-brand-400"
        :aria-label="t('status.more_actions')"
      >
        <svg class="h-6 w-6 sm:h-5 sm:w-5" fill="currentColor" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.75" /><circle cx="12" cy="12" r="1.75" /><circle cx="19" cy="12" r="1.75" /></svg>
      </button>

      <!-- Dropdown -->
      <div
        v-if="showMenu"
        ref="moreMenuRef"
        class="sb-menu absolute right-0 z-50 w-44 animate-fade-in"
        :class="menuOpensDown ? 'top-full mt-1.5' : 'bottom-full mb-1.5'"
      >
        <button
          v-if="permissions.edit"
          @click="handleEdit(statusId)"
          class="sb-menu-item"
        >
          <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" /></svg>
          {{ t('status.edit') }}
        </button>
        <button
          v-if="permissions.delete"
          @click="handleDelete(statusId)"
          class="sb-menu-item text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10"
        >
          <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" /></svg>
          {{ t('status.delete_action') }}
        </button>
        <button
          v-if="permissions.mute"
          @click="handleMute"
          class="sb-menu-item text-amber-600 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-500/10"
        >
          <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M17.25 9.75L19.5 12m0 0l2.25 2.25M19.5 12l2.25-2.25M19.5 12l-2.25 2.25m-10.5-6l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" /></svg>
          {{ t('account.mute') }}
        </button>
        <button
          v-if="permissions.block"
          @click="handleBlock"
          class="sb-menu-item text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10"
        >
          <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" /></svg>
          {{ t('account.block') }}
        </button>
        <button
          v-if="permissions.report"
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
