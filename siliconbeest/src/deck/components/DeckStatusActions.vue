<script setup lang="ts">
// Deck-only action row: fewer visible buttons than the Aurora StatusActions.
// Boost = repost/quote chooser, Star = favourite/emoji-reaction chooser,
// Share lives in the ⋯ menu. Emits stay compatible with StatusActions, plus
// `react` (open the emoji picker) and `overlay` (a popover opened/closed —
// the card raises its z-index above sibling cards while one is open).
import { ref, computed, watch } from 'vue'
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
  react: [id: string]
  overlay: [open: boolean]
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

const showBoostMenu = ref(false)
const showStarMenu = ref(false)
const showMoreMenu = ref(false)

const anyMenuOpen = computed(() => showBoostMenu.value || showStarMenu.value || showMoreMenu.value)

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
  if (props.accountId && props.accountAcct) {
    emit('report', { accountId: props.accountId, accountAcct: props.accountAcct, statusId: props.statusId })
  }
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
      type="button"
      class="dk-mono dk-dim-text inline-flex cursor-pointer items-center gap-1.5 rounded-lg border-0 bg-transparent px-2.5 py-1.5 text-[12px] transition-colors hover:bg-[var(--dk-surface2)] hover:text-[var(--dk-text)]"
      :aria-label="t('status.reply')"
      @click="emit('reply', statusId)"
    >
      <span aria-hidden="true">↩</span>
      <span class="tabular-nums">{{ formatCount(repliesCount) }}</span>
    </button>

    <!-- Boost chooser: repost or quote -->
    <div class="relative">
      <button
        type="button"
        class="dk-mono inline-flex cursor-pointer items-center gap-1.5 rounded-lg border-0 bg-transparent px-2.5 py-1.5 text-[12px] transition-colors hover:bg-[var(--dk-surface2)]"
        :style="reblogged ? 'color: var(--dk-acc)' : 'color: var(--dk-dim)'"
        :aria-label="t('status.boost')"
        :aria-expanded="showBoostMenu"
        :aria-pressed="reblogged"
        @click="openBoostMenu"
      >
        <span aria-hidden="true">⇄</span>
        <span class="tabular-nums">{{ formatCount(reblogsCount) }}</span>
      </button>
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
    <div class="relative">
      <button
        type="button"
        class="dk-mono inline-flex cursor-pointer items-center gap-1.5 rounded-lg border-0 bg-transparent px-2.5 py-1.5 text-[12px] transition-colors hover:bg-[var(--dk-surface2)]"
        :style="favourited ? 'color: var(--dk-acc)' : 'color: var(--dk-dim)'"
        :aria-label="t('status.favourite')"
        :aria-expanded="showStarMenu"
        :aria-pressed="favourited"
        @click="openStarMenu"
      >
        <span aria-hidden="true">{{ favourited ? '★' : '☆' }}</span>
        <span class="tabular-nums">{{ formatCount(favouritesCount) }}</span>
      </button>
      <div v-if="showStarMenu" class="dk-menu absolute bottom-full left-0 z-50 mb-1.5 w-48">
        <button
          type="button"
          class="dk-menu-item"
          :disabled="loadingFavourite"
          @click="pick(() => emit('favourite', statusId))"
        >
          <span aria-hidden="true">{{ favourited ? '★' : '☆' }}</span>
          <span>{{ favourited ? t('deck.unfavourite') : t('status.favourite') }}</span>
        </button>
        <button
          type="button"
          class="dk-menu-item"
          @click="pick(() => emit('react', statusId))"
        >
          <span aria-hidden="true">😀</span>
          <span>{{ t('deck.react') }}</span>
        </button>
      </div>
    </div>

    <!-- Bookmark -->
    <button
      type="button"
      class="dk-mono inline-flex cursor-pointer items-center gap-1.5 rounded-lg border-0 bg-transparent px-2.5 py-1.5 text-[12px] transition-colors hover:bg-[var(--dk-surface2)]"
      :style="bookmarked ? 'color: var(--dk-acc2)' : 'color: var(--dk-dim)'"
      :disabled="loadingBookmark"
      :aria-label="t('status.bookmark')"
      :aria-pressed="bookmarked"
      @click="emit('bookmark', statusId)"
    >
      <span aria-hidden="true">{{ bookmarked ? '🔖' : '🏷' }}</span>
    </button>

    <div class="flex-1" />

    <!-- More: share + management -->
    <div class="relative">
      <button
        type="button"
        class="dk-mono dk-dim-text inline-flex cursor-pointer items-center rounded-lg border-0 bg-transparent px-2.5 py-1.5 text-[12px] transition-colors hover:bg-[var(--dk-surface2)] hover:text-[var(--dk-text)]"
        :aria-label="t('status.more_actions')"
        :aria-expanded="showMoreMenu"
        @click="openMoreMenu"
      >
        ⋯
      </button>
      <div v-if="showMoreMenu" class="dk-menu absolute bottom-full right-0 z-50 mb-1.5 w-48">
        <button type="button" class="dk-menu-item" @click="pick(() => emit('share', statusId))">
          <span aria-hidden="true">↗</span>
          <span>{{ t('status.share') }}</span>
        </button>
        <button v-if="isOwnStatus" type="button" class="dk-menu-item" @click="pick(() => emit('edit', statusId))">
          <span aria-hidden="true">✎</span>
          <span>{{ t('status.edit') }}</span>
        </button>
        <button
          v-if="isOwnStatus"
          type="button"
          class="dk-menu-item"
          style="color: #f87171"
          @click="pick(() => emit('delete', statusId))"
        >
          <span aria-hidden="true">🗑</span>
          <span>{{ t('status.delete_action') }}</span>
        </button>
        <button
          v-if="!isOwnStatus && accountId"
          type="button"
          class="dk-menu-item"
          @click="pick(() => emit('mute', accountId!))"
        >
          <span aria-hidden="true">🔇</span>
          <span>{{ t('profile.mute') }}</span>
        </button>
        <button
          v-if="!isOwnStatus && accountId"
          type="button"
          class="dk-menu-item"
          style="color: #f87171"
          @click="pick(() => emit('block', accountId!))"
        >
          <span aria-hidden="true">🚫</span>
          <span>{{ t('profile.block') }}</span>
        </button>
        <button
          v-if="!isOwnStatus"
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
