<script setup lang="ts">
// Deck-only action row: fewer visible buttons than the Aurora StatusActions.
// Boost = repost/quote chooser, Star = favourite/emoji-reaction chooser,
// Share lives in the ⋯ menu. Emits stay compatible with StatusActions, plus
// `react` (open the emoji picker) and `overlay` (a popover opened/closed —
// the card raises its z-index above sibling cards while one is open).
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { getStatusActionPermissions } from '@/utils/permissions'

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

const emit = defineEmits<{
  reply: [id: string]
  reblog: [id: string]
  quote: [id: string]
  favourite: [id: string]
  viewReblogs: [id: string]
  viewFavourites: [id: string]
  bookmark: [id: string]
  share: [id: string]
  edit: [id: string]
  delete: [id: string]
  report: [payload: { accountId: string; accountAcct: string; statusId: string }]
  block: [accountId: string]
  mute: [accountId: string]
  react: [id: string, anchor?: HTMLElement]
  overlay: [open: boolean]
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

const starBtnRef = ref<HTMLElement | null>(null)
const showBoostMenu = ref(false)
const showStarMenu = ref(false)
const showMoreMenu = ref(false)

const anyMenuOpen = computed(() => showBoostMenu.value || showStarMenu.value || showMoreMenu.value)
const hasMoreActions = computed(() => (
  permissions.value.bookmark
  || permissions.value.share
  || permissions.value.edit
  || permissions.value.delete
  || permissions.value.report
  || permissions.value.block
  || permissions.value.mute
))

watch(anyMenuOpen, (open) => emit('overlay', open))

function closeMenus() {
  showBoostMenu.value = false
  showStarMenu.value = false
  showMoreMenu.value = false
}

function openBoostMenu() {
  const next = !showBoostMenu.value
  closeMenus()
  showBoostMenu.value = next
}

function openStarMenu() {
  const next = !showStarMenu.value
  closeMenus()
  showStarMenu.value = next
}

function openMoreMenu() {
  const next = !showMoreMenu.value
  closeMenus()
  showMoreMenu.value = next
}

function pick(action: () => void) {
  closeMenus()
  action()
}

function handleReport() {
  if (permissions.value.report && props.accountId && props.accountAcct) {
    emit('report', { accountId: props.accountId, accountAcct: props.accountAcct, statusId: props.statusId })
  }
}

function handleBlock() {
  if (permissions.value.block && props.accountId) emit('block', props.accountId)
}

function handleMute() {
  if (permissions.value.mute && props.accountId) emit('mute', props.accountId)
}

function formatCount(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return n > 0 ? String(n) : ''
}
</script>

<template>
  <div class="flex items-center gap-0.5" role="group" :aria-label="t('status.actions')">
    <!-- Backdrop for any open chooser -->
    <div v-if="anyMenuOpen" class="fixed inset-0 z-40" aria-hidden="true" @click.stop="closeMenus" />

    <!-- Reply -->
    <button
      data-test="reply-action"
      type="button"
      :disabled="!permissions.reply"
      class="dk-mono dk-dim-text inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-[10px] border-0 bg-transparent px-3 py-2.5 text-sm transition-colors hover:bg-[var(--dk-surface2)] hover:text-[var(--dk-text)]"
      :aria-label="t('status.reply')"
      @click="permissions.reply && emit('reply', statusId)"
    >
      <span class="text-xl leading-none" aria-hidden="true">↩</span>
      <span class="tabular-nums">{{ formatCount(repliesCount) }}</span>
    </button>

    <!-- Boost chooser: repost or quote -->
    <div class="relative flex items-center">
      <button
        data-test="reblog-action"
        type="button"
        :disabled="!canReblog && !canQuote"
        class="dk-mono inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-[10px] border-0 bg-transparent px-3 py-2.5 text-sm transition-colors hover:bg-[var(--dk-surface2)]"
        :style="reblogged ? 'color: var(--dk-acc)' : 'color: var(--dk-dim)'"
        :aria-label="t('status.boost')"
        :aria-expanded="showBoostMenu"
        :aria-pressed="reblogged"
        aria-haspopup="menu"
        @click="(canReblog || canQuote) && openBoostMenu()"
      >
        <span class="text-xl leading-none" aria-hidden="true">⇄</span>
      </button>
      <button
        v-if="viewerAuthenticated && reblogsCount > 0"
        data-test="reblogs-count"
        type="button"
        class="dk-mono -ml-1.5 min-h-11 rounded-[10px] border-0 bg-transparent px-2 text-[13.5px] font-semibold tabular-nums underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--dk-acc)]"
        style="color: var(--dk-dim)"
        :aria-label="t('status.view_reblogs', { count: reblogsCount })"
        aria-haspopup="dialog"
        @click.stop="emit('viewReblogs', statusId)"
      >
        {{ formatCount(reblogsCount) }}
      </button>
      <span v-else-if="reblogsCount > 0" class="dk-mono -ml-1.5 px-2 text-[13.5px] font-semibold tabular-nums" style="color: var(--dk-dim)">
        <span aria-hidden="true">{{ formatCount(reblogsCount) }}</span>
        <span class="sr-only">{{ t('status.reblogs_count', { count: reblogsCount }) }}</span>
      </span>
      <div v-if="showBoostMenu" class="dk-menu absolute bottom-full left-0 z-50 mb-1.5 w-48">
        <button
          type="button"
          class="dk-menu-item"
          :disabled="!canReblog || loadingReblog"
          :style="!canReblog ? 'opacity: 0.5; cursor: not-allowed' : ''"
          :title="!canReblog ? t('status.cannot_boost') : undefined"
          @click="canReblog && pick(() => emit('reblog', statusId))"
        >
          <span aria-hidden="true">⇄</span>
          <span>{{ reblogged ? t('deck.unboost') : t('status.boost') }}</span>
        </button>
        <button
          type="button"
          class="dk-menu-item"
          :disabled="!canQuote"
          :style="!canQuote ? 'opacity: 0.5; cursor: not-allowed' : ''"
          :title="quoteTooltip"
          @click="canQuote && pick(() => emit('quote', statusId))"
        >
          <span aria-hidden="true">❝</span>
          <span>{{ t('status.quote') }}</span>
        </button>
      </div>
    </div>

    <!-- Star chooser: favourite or emoji reaction -->
    <div class="relative flex items-center">
      <button
        ref="starBtnRef"
        data-test="favourite-action"
        type="button"
        :disabled="!permissions.favourite && !permissions.react"
        class="dk-mono inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-[10px] border-0 bg-transparent px-3 py-2.5 text-sm transition-colors hover:bg-[var(--dk-surface2)]"
        :style="favourited ? 'color: var(--dk-acc)' : 'color: var(--dk-dim)'"
        :aria-label="t('status.favourite')"
        :aria-expanded="showStarMenu"
        :aria-pressed="favourited"
        aria-haspopup="menu"
        @click="(permissions.favourite || permissions.react) && openStarMenu()"
      >
        <span class="text-xl leading-none" aria-hidden="true">{{ favourited ? '★' : '☆' }}</span>
      </button>
      <button
        v-if="viewerAuthenticated && favouritesCount > 0"
        data-test="favourites-count"
        type="button"
        class="dk-mono -ml-1.5 min-h-11 rounded-[10px] border-0 bg-transparent px-2 text-[13.5px] font-semibold tabular-nums underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--dk-acc)]"
        style="color: var(--dk-dim)"
        :aria-label="t('status.view_favourites', { count: favouritesCount })"
        aria-haspopup="dialog"
        @click.stop="emit('viewFavourites', statusId)"
      >
        {{ formatCount(favouritesCount) }}
      </button>
      <span v-else-if="favouritesCount > 0" class="dk-mono -ml-1.5 px-2 text-[13.5px] font-semibold tabular-nums" style="color: var(--dk-dim)">
        <span aria-hidden="true">{{ formatCount(favouritesCount) }}</span>
        <span class="sr-only">{{ t('status.favourites_count', { count: favouritesCount }) }}</span>
      </span>
      <div v-if="showStarMenu" class="dk-menu absolute bottom-full left-0 z-50 mb-1.5 w-48">
        <button
          type="button"
          class="dk-menu-item"
          :disabled="!permissions.favourite || loadingFavourite"
          @click="permissions.favourite && pick(() => emit('favourite', statusId))"
        >
          <span aria-hidden="true">{{ favourited ? '★' : '☆' }}</span>
          <span>{{ favourited ? t('deck.unfavourite') : t('status.favourite') }}</span>
        </button>
        <button
          type="button"
          class="dk-menu-item"
          :disabled="!permissions.react"
          @click="permissions.react && pick(() => emit('react', statusId, starBtnRef ?? undefined))"
        >
          <span aria-hidden="true">😀</span>
          <span>{{ t('deck.react') }}</span>
        </button>
      </div>
    </div>

    <div class="flex-1" />

    <!-- More: share + management -->
    <div v-if="hasMoreActions" class="relative">
      <button
        data-test="more-action"
        type="button"
        class="dk-mono dk-dim-text inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-[10px] border-0 bg-transparent px-3 py-2.5 text-sm transition-colors hover:bg-[var(--dk-surface2)] hover:text-[var(--dk-text)]"
        :aria-label="t('status.more_actions')"
        :aria-expanded="showMoreMenu"
        @click="openMoreMenu"
      >
        ⋯
      </button>
      <div v-if="showMoreMenu" class="dk-menu absolute bottom-full right-0 z-50 mb-1.5 w-52">
        <button
          v-if="permissions.bookmark"
          type="button"
          class="dk-menu-item"
          :disabled="!permissions.bookmark || loadingBookmark"
          :style="bookmarked ? 'color: var(--dk-acc)' : ''"
          @click="pick(() => emit('bookmark', statusId))"
        >
          <span aria-hidden="true">🔖</span>
          <span>{{ bookmarked ? t('deck.unbookmark') : t('status.bookmark') }}</span>
        </button>
        <button
          v-if="permissions.share"
          type="button"
          class="dk-menu-item"
          @click="pick(() => emit('share', statusId))"
        >
          <span aria-hidden="true">↗</span>
          <span>{{ t('status.share') }}</span>
        </button>
        <button v-if="permissions.edit" type="button" class="dk-menu-item" @click="pick(() => emit('edit', statusId))">
          <span aria-hidden="true">✎</span>
          <span>{{ t('status.edit') }}</span>
        </button>
        <button
          v-if="permissions.delete"
          type="button"
          class="dk-menu-item"
          style="color: #f87171"
          @click="pick(() => emit('delete', statusId))"
        >
          <span aria-hidden="true">🗑</span>
          <span>{{ t('status.delete_action') }}</span>
        </button>
        <button
          v-if="permissions.mute && accountId"
          type="button"
          class="dk-menu-item"
          @click="pick(handleMute)"
        >
          <span aria-hidden="true">🔇</span>
          <span>{{ t('profile.mute') }}</span>
        </button>
        <button
          v-if="permissions.block && accountId"
          type="button"
          class="dk-menu-item"
          style="color: #f87171"
          @click="pick(handleBlock)"
        >
          <span aria-hidden="true">🚫</span>
          <span>{{ t('profile.block') }}</span>
        </button>
        <button
          v-if="permissions.report"
          type="button"
          class="dk-menu-item"
          style="color: #f87171"
          @click="pick(handleReport)"
        >
          <span aria-hidden="true">🚩</span>
          <span>{{ t('status.report') }}</span>
        </button>
      </div>
    </div>
  </div>
</template>
