<script setup lang="ts">
// Logic mirrored from src/components/status/StatusCard.vue (Aurora) — keep
// behavior in sync; only the template/styling is Deck-specific.
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Status } from '@/types/mastodon'
import { useStatusesStore } from '@/stores/statuses'
import { useTimelinesStore } from '@/stores/timelines'
import { useAuthStore } from '@/stores/auth'
import { useAccountsStore } from '@/stores/accounts'
import { useComposeStore } from '@/stores/compose'
import { useUiStore } from '@/stores/ui'
import { useInstanceStore } from '@/stores/instance'
import { useNow } from '@/composables/useNow'
import Avatar from '@/components/common/Avatar.vue'
import StatusContent from '@/components/status/StatusContent.vue'
import DeckStatusActions from './DeckStatusActions.vue'
import MediaGallery from '@/components/status/MediaGallery.vue'
import PreviewCard from '@/components/status/PreviewCard.vue'
import StatusPoll from '@/components/status/StatusPoll.vue'
import DeckStatusReactions from './DeckStatusReactions.vue'
import StatusEngagementDialog from '@/components/status/StatusEngagementDialog.vue'
import ReportDialog from '@/components/common/ReportDialog.vue'
import ImageViewer from '@/components/common/ImageViewer.vue'
import { emojifyPlainText } from '@/utils/customEmoji'
import { canUseAuthenticatedActions, getStatusActionPermissions } from '@/utils/permissions'
import { blockAccount, muteAccount } from '@/api/mastodon/accounts'

const { t } = useI18n()
const statusesStore = useStatusesStore()
const timelinesStore = useTimelinesStore()
const authStore = useAuthStore()
const accountsStore = useAccountsStore()
const composeStore = useComposeStore()
const uiStore = useUiStore()
const instanceStore = useInstanceStore()
const { now } = useNow()

const props = defineProps<{
  status: Status
}>()

const emit = defineEmits<{
  reply: [status: Status]
  deleted: [statusId: string]
  navigate: [status: Status]
}>()

// Resolve status from the store cache so optimistic updates are reactive
const cachedStatus = computed(() => statusesStore.getCached(props.status.id) ?? props.status)

const isReblog = computed(() => !!cachedStatus.value.reblog)
const displayStatus = computed(() => {
  if (cachedStatus.value.reblog) {
    return statusesStore.getCached(cachedStatus.value.reblog.id) ?? cachedStatus.value.reblog
  }
  return cachedStatus.value
})

const isEditing = ref(false)
const editText = ref('')
const editSpoilerText = ref('')
const editSensitive = ref(false)
const editLoading = ref(false)

const loadingFavourite = ref(false)
const loadingReblog = ref(false)
const loadingBookmark = ref(false)

const showReportDialog = ref(false)
const showImageViewer = ref(false)
const imageViewerIndex = ref(0)
const showShareModal = ref(false)
const shareUrl = ref('')
const shareCopied = ref(false)
const engagementKind = ref<'favourites' | 'reblogs' | null>(null)

function openImageViewer(index: number) {
  imageViewerIndex.value = index
  showImageViewer.value = true
}
const reportTarget = ref<{ accountId: string; accountAcct: string; statusId: string } | null>(null)

function handleReport(payload: { accountId: string; accountAcct: string; statusId: string }) {
  if (!statusActionPermissions.value.report) return
  reportTarget.value = payload
  showReportDialog.value = true
}

function openEngagement(kind: 'favourites' | 'reblogs', statusId: string) {
  if (!authStore.isAuthenticated || !authStore.token || statusId !== displayStatus.value.id) return
  engagementKind.value = kind
}

const isOwnStatus = computed(() => {
  return authStore.currentUser?.id === displayStatus.value.account.id
})

const accountCanAct = computed(() => canUseAuthenticatedActions({
  authenticated: authStore.isAuthenticated,
  accountLoaded: authStore.currentUser !== null,
  accountSuspended: authStore.currentUser?.suspended,
  accountMemorial: authStore.currentUser?.memorial,
}))
const statusActionPermissions = computed(() => getStatusActionPermissions({
  accountCanAct: accountCanAct.value,
  isOwnStatus: isOwnStatus.value,
  visibility: displayStatus.value.visibility,
  quotePolicyAllows: displayStatus.value.quote_policy_allows,
}))

async function handleBlock(accountId: string) {
  if (!accountCanAct.value || !authStore.token) return
  try {
    const { data } = await blockAccount(accountId, authStore.token)
    accountsStore.updateRelationship(data)
    timelinesStore.removeAccountStatuses(accountId)
  } catch {
    // Keep the current UI when the relationship update is rejected.
  }
}

async function handleMute(accountId: string) {
  if (!accountCanAct.value || !authStore.token) return
  try {
    const { data } = await muteAccount(accountId, authStore.token)
    accountsStore.updateRelationship(data)
    timelinesStore.removeAccountStatuses(accountId)
  } catch {
    // Keep the current UI when the relationship update is rejected.
  }
}

const relativeTime = computed(() => {
  const date = new Date(displayStatus.value.created_at)
  const diffMs = now.value - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  if (diffMins < 1) return t('time.just_now')
  if (diffMins < 60) return t('time.minutes_ago', { n: diffMins })
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return t('time.hours_ago', { n: diffHours })
  const diffDays = Math.floor(diffHours / 24)
  return t('time.days_ago', { n: diffDays })
})

const emojifiedDisplayName = computed(() => {
  return emojifyPlainText(
    displayStatus.value.account.display_name || '',
    displayStatus.value.account.emojis,
    'custom-emoji inline-block h-5 max-w-8 align-text-bottom',
  )
})

const hasAccountEmojis = computed(() => {
  return (displayStatus.value.account.emojis?.length ?? 0) > 0
})

// Deck instance chip: domain + a stable per-instance dot color
const INSTANCE_DOT_PALETTE = ['#4ed9c6', '#b48cff', '#ff8a5c', '#ffd166', '#7fb2ff', '#f472b6']

const instanceDomain = computed(() => {
  const acct = displayStatus.value.account.acct
  return acct.includes('@') ? acct.split('@')[1]! : instanceStore.instance?.domain || ''
})

const instanceDotColor = computed(() => {
  const domain = instanceDomain.value
  if (!domain) return 'var(--dk-dim)'
  if (domain === instanceStore.instance?.domain) return 'var(--dk-acc)'
  let h = 0
  for (let i = 0; i < domain.length; i++) h = (h * 31 + domain.charCodeAt(i)) | 0
  return INSTANCE_DOT_PALETTE[Math.abs(h) % INSTANCE_DOT_PALETTE.length]!
})

const replyToDisplay = computed(() => {
  const status = displayStatus.value
  if (status.mentions?.length) {
    const mention = status.mentions.find(
      (m: any) => m.id === status.in_reply_to_account_id
    )
    if (mention) return `@${(mention as any).acct || (mention as any).username}`
  }
  if (status.in_reply_to_account_id === status.account.id) {
    return `@${status.account.acct}`
  }
  const cached = accountsStore.getCached(status.in_reply_to_account_id!)
  if (cached) return `@${cached.acct}`
  if (status.in_reply_to_account_id) {
    accountsStore.getAccount(status.in_reply_to_account_id)
  }
  return '...'
})

async function handleFavourite() {
  if (!statusActionPermissions.value.favourite || loadingFavourite.value) return
  loadingFavourite.value = true
  try {
    const target = cachedStatus.value.reblog ?? cachedStatus.value
    await statusesStore.toggleFavourite(target)
  } finally {
    loadingFavourite.value = false
  }
}

async function handleReblog() {
  if (!statusActionPermissions.value.reblog || loadingReblog.value) return
  loadingReblog.value = true
  try {
    const target = cachedStatus.value.reblog ?? cachedStatus.value
    await statusesStore.toggleReblog(target)
  } finally {
    loadingReblog.value = false
  }
}

async function handleBookmark() {
  if (!statusActionPermissions.value.bookmark || loadingBookmark.value) return
  loadingBookmark.value = true
  try {
    const target = cachedStatus.value.reblog ?? cachedStatus.value
    await statusesStore.toggleBookmark(target)
  } finally {
    loadingBookmark.value = false
  }
}

function handleReply() {
  if (!statusActionPermissions.value.reply) return
  const target = cachedStatus.value.reblog ?? cachedStatus.value
  composeStore.setReplyTo(target)
  uiStore.openComposeModal()
}

function handleQuote() {
  if (!statusActionPermissions.value.quote) return
  const target = cachedStatus.value.reblog ?? cachedStatus.value
  composeStore.setQuote(target)
  uiStore.openComposeModal()
}

function handleCardClick() {
  const target = cachedStatus.value.reblog ?? cachedStatus.value
  emit('navigate', target)
}

async function handleShare() {
  const target = displayStatus.value
  const url = target.url || `${window.location.origin}/@${target.account.acct}/${target.id}`
  if (navigator.share) {
    try {
      await navigator.share({ url })
      return
    } catch {
      // User cancelled or share failed — fall through to modal
    }
  }
  shareUrl.value = url
  shareCopied.value = false
  showShareModal.value = true
}

async function copyShareUrl() {
  try {
    await navigator.clipboard.writeText(shareUrl.value)
    shareCopied.value = true
    setTimeout(() => { shareCopied.value = false }, 2000)
  } catch {
    const input = document.querySelector('.dk-share-url-input') as HTMLInputElement
    if (input) {
      input.select()
      document.execCommand('copy')
      shareCopied.value = true
      setTimeout(() => { shareCopied.value = false }, 2000)
    }
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim()
}

function handleEdit() {
  if (!statusActionPermissions.value.edit) return
  const s = displayStatus.value
  editText.value = s.text || stripHtml(s.content || '')
  editSpoilerText.value = s.spoiler_text || ''
  editSensitive.value = s.sensitive || false
  isEditing.value = true
}

function cancelEdit() {
  isEditing.value = false
  editText.value = ''
  editSpoilerText.value = ''
  editSensitive.value = false
}

async function submitEdit() {
  if (!statusActionPermissions.value.edit || editLoading.value) return
  editLoading.value = true
  try {
    await statusesStore.editStatus(displayStatus.value.id, {
      status: editText.value,
      spoiler_text: editSpoilerText.value || undefined,
      sensitive: editSensitive.value,
    })
    isEditing.value = false
  } catch {
    // Error handling - keep edit mode open
  } finally {
    editLoading.value = false
  }
}

function handlePollUpdate(updatedPoll: Status['poll']) {
  const target = cachedStatus.value.reblog ?? cachedStatus.value
  if (updatedPoll) {
    statusesStore.cacheStatus({ ...target, poll: updatedPoll })
  }
}

function handleReactionUpdate(updatedStatus: Status) {
  statusesStore.cacheStatus(updatedStatus)
}

// Each deck card is a stacking context (entrance animation), so popovers
// can't escape above later sibling cards — raise this card while one is open.
const reactionsRef = ref<InstanceType<typeof DeckStatusReactions> | null>(null)
const actionsOverlayOpen = ref(false)
const reactionsOverlayOpen = ref(false)
const overlayOpen = computed(() => actionsOverlayOpen.value || reactionsOverlayOpen.value)

function handleReact(_id: string, anchor?: HTMLElement) {
  if (!statusActionPermissions.value.react) return
  reactionsRef.value?.openPicker(anchor)
}

async function handleDelete() {
  if (!statusActionPermissions.value.delete) return
  if (!confirm(t('status.delete_confirm'))) return
  const targetStatusId = displayStatus.value.id
  try {
    const removedIds = await statusesStore.deleteStatus(targetStatusId)
    for (const removedId of removedIds) timelinesStore.removeStatus(removedId)
    emit('deleted', targetStatusId)
  } catch {
    // Error handling
  }
}
</script>

<template>
  <article
    v-if="displayStatus.content || isReblog || displayStatus.media_attachments?.length"
    class="dk-card dk-note-in relative cursor-pointer"
    :class="{ 'z-30': overlayOpen }"
    style="padding: var(--dk-pad)"
    :aria-label="t('status.by', { name: displayStatus.account.display_name })"
    @click="handleCardClick"
  >
    <!-- Reblog indicator -->
    <div
      v-if="isReblog"
      class="dk-mono mb-2 flex items-center gap-1.5 text-[11px]"
      style="color: var(--dk-acc2)"
    >
      <span aria-hidden="true">⇄</span>
      <router-link
        :to="`/@${cachedStatus.account.acct}`"
        class="truncate font-semibold no-underline hover:underline"
        style="color: inherit"
        @click.stop
      >
        {{ cachedStatus.account.display_name || cachedStatus.account.username }}
      </router-link>
      <span class="flex-shrink-0">{{ t('status.reblogged') }}</span>
    </div>

    <!-- Reply indicator -->
    <div v-if="displayStatus.in_reply_to_id" class="dk-mono dk-dim-text mb-1.5 flex items-center gap-1.5 text-[11px]">
      <span aria-hidden="true">↩</span>
      <router-link
        v-if="displayStatus.in_reply_to_account_id"
        :to="displayStatus.in_reply_to_id ? `/@${displayStatus.account.acct}/${displayStatus.in_reply_to_id}` : '#'"
        class="truncate no-underline hover:underline"
        style="color: inherit"
        @click.stop
      >
        {{ t('status.repliedTo', { user: replyToDisplay }) }}
      </router-link>
      <span v-else class="truncate">{{ t('status.repliedTo', { user: '...' }) }}</span>
    </div>

    <!-- Header -->
    <div class="flex items-start gap-2.5">
      <router-link
        :to="`/@${displayStatus.account.acct}`"
        class="dk-avatar block h-[42px] w-[42px] flex-none overflow-hidden rounded-[13px]"
        @click.stop
      >
        <Avatar :src="displayStatus.account.avatar" :alt="displayStatus.account.display_name" size="md" />
      </router-link>

      <div class="flex min-w-0 flex-1 flex-col gap-[3px]">
        <div class="flex flex-wrap items-baseline gap-[7px]">
          <router-link
            :to="`/@${displayStatus.account.acct}`"
            class="dk-text min-w-0 truncate text-[14.5px] font-bold no-underline hover:underline"
            @click.stop
          >
            <span v-if="hasAccountEmojis" v-html="emojifiedDisplayName" />
            <template v-else>{{ displayStatus.account.display_name || displayStatus.account.username }}</template>
          </router-link>
          <span class="dk-mono dk-dim-text min-w-0 truncate text-[11.5px]">@{{ displayStatus.account.acct }}</span>
        </div>
        <span v-if="instanceDomain" class="dk-chip">
          <span
            class="h-1.5 w-1.5 rounded-full"
            :style="{ background: instanceDotColor }"
            aria-hidden="true"
          />{{ instanceDomain }}
        </span>
      </div>

      <div class="dk-mono dk-dim-text flex flex-none items-center gap-1.5 text-[11px]">
        <span
          v-if="displayStatus.visibility && displayStatus.visibility !== 'public'"
          :title="t(`status.visibility_${displayStatus.visibility}`)"
        >
          <template v-if="displayStatus.visibility === 'unlisted'">🔓</template>
          <template v-else-if="displayStatus.visibility === 'private'">🔒</template>
          <template v-else-if="displayStatus.visibility === 'direct'">✉️</template>
        </span>
        <span v-if="displayStatus.edited_at" :title="displayStatus.edited_at">({{ t('status.edited') }})</span>
        <time :datetime="displayStatus.created_at" class="whitespace-nowrap">{{ relativeTime }}</time>
      </div>
    </div>

    <!-- Edit mode -->
    <div v-if="isEditing" class="mt-2.5 space-y-2">
      <div class="dk-mono text-[10.5px] font-semibold uppercase tracking-wide" style="color: var(--dk-acc)">
        {{ t('status.editing') }}
      </div>
      <textarea
        v-model="editText"
        class="dk-input resize-none"
        rows="3"
      />
      <input
        v-if="displayStatus.spoiler_text"
        v-model="editSpoilerText"
        type="text"
        :placeholder="t('compose.cw_placeholder')"
        class="dk-input"
      />
      <div v-if="displayStatus.media_attachments?.length" class="flex flex-wrap gap-2">
        <div
          v-for="media in displayStatus.media_attachments"
          :key="media.id"
          class="h-20 w-20 overflow-hidden rounded-xl"
          style="border: 1px solid var(--dk-border)"
        >
          <img
            :src="media.preview_url || media.url"
            :alt="media.description || ''"
            class="h-full w-full object-cover"
          />
        </div>
      </div>
      <div class="flex items-center gap-2">
        <button
          :disabled="editLoading || !editText.trim()"
          class="dk-btn-accent !px-4 !py-2 !text-[13px]"
          @click="submitEdit"
        >
          {{ t('common.save') }}
        </button>
        <button
          class="dk-pill-btn"
          @click="cancelEdit"
        >
          {{ t('common.cancel') }}
        </button>
      </div>
    </div>

    <!-- Normal content display -->
    <template v-else>
      <div class="mt-2.5" style="font-size: var(--dk-fs)">
        <StatusContent
          :content="displayStatus.content"
          :spoiler-text="displayStatus.spoiler_text"
          :sensitive="displayStatus.sensitive"
          :emojis="displayStatus.emojis"
          :hide-quote-inline="!!displayStatus.quote"
        />
      </div>

      <!-- Poll -->
      <StatusPoll
        v-if="displayStatus.poll"
        :poll="displayStatus.poll"
        @updated="handlePollUpdate"
        @click.stop
      />

      <!-- Media -->
      <MediaGallery
        v-if="displayStatus.media_attachments?.length"
        :attachments="displayStatus.media_attachments"
        class="mt-2.5"
        @expand="openImageViewer"
        @click.stop
      />

      <!-- Preview Card -->
      <PreviewCard
        v-if="displayStatus.card && !displayStatus.media_attachments?.length"
        :card="displayStatus.card"
        @click.stop
      />

      <!-- Quote -->
      <div
        v-if="displayStatus.quote"
        class="mt-2.5 cursor-pointer rounded-xl px-3 py-2.5 transition-colors"
        style="border: 1px solid var(--dk-border); border-left: 3px solid var(--dk-acc2); background: var(--dk-surface2)"
        @click.stop="emit('navigate', displayStatus.quote)"
      >
        <div class="dk-mono dk-dim-text mb-1 flex min-w-0 items-center gap-[7px] text-[11px]">
          <span class="dk-text truncate font-semibold">{{ displayStatus.quote.account.display_name || displayStatus.quote.account.username }}</span>
          <span class="truncate">@{{ displayStatus.quote.account.acct }}</span>
        </div>
        <StatusContent
          :content="displayStatus.quote.content"
          :spoiler-text="displayStatus.quote.spoiler_text"
          :sensitive="displayStatus.quote.sensitive"
          :emojis="displayStatus.quote.emojis"
        />
      </div>
    </template>

    <!-- Emoji reactions -->
    <DeckStatusReactions
      ref="reactionsRef"
      :status="displayStatus"
      class="mt-2.5"
      @updated="handleReactionUpdate"
      @overlay="reactionsOverlayOpen = $event"
      @click.stop
    />

    <!-- Actions -->
    <DeckStatusActions @click.stop
      :status-id="displayStatus.id"
      :replies-count="displayStatus.replies_count"
      :reblogs-count="displayStatus.reblogs_count"
      :favourites-count="displayStatus.favourites_count"
      :favourited="displayStatus.favourited"
      :reblogged="displayStatus.reblogged"
      :bookmarked="displayStatus.bookmarked"
      :account-can-act="accountCanAct"
      :viewer-authenticated="authStore.isAuthenticated"
      :is-own-status="isOwnStatus"
      :account-id="displayStatus.account.id"
      :account-acct="displayStatus.account.acct"
      :visibility="displayStatus.visibility"
      :quote-policy-allows="displayStatus.quote_policy_allows"
      :quote-policy-reason="displayStatus.quote_policy_reason"
      :loading-favourite="loadingFavourite"
      :loading-reblog="loadingReblog"
      :loading-bookmark="loadingBookmark"
      class="mt-2"
      @favourite="handleFavourite"
      @reblog="handleReblog"
      @view-favourites="openEngagement('favourites', $event)"
      @view-reblogs="openEngagement('reblogs', $event)"
      @quote="handleQuote"
      @bookmark="handleBookmark"
      @reply="handleReply"
      @share="handleShare"
      @edit="handleEdit"
      @delete="handleDelete"
      @report="handleReport"
      @block="handleBlock"
      @mute="handleMute"
      @react="handleReact"
      @overlay="actionsOverlayOpen = $event"
    />

    <!-- Report dialog -->
    <ReportDialog
      v-if="reportTarget"
      :open="showReportDialog"
      :account-id="reportTarget.accountId"
      :account-acct="reportTarget.accountAcct"
      :status-id="reportTarget.statusId"
      @close="showReportDialog = false"
    />

    <StatusEngagementDialog
      v-if="engagementKind"
      :open="true"
      :status-id="displayStatus.id"
      :kind="engagementKind"
      variant="deck"
      @click.stop
      @close="engagementKind = null"
    />

    <!-- Share Modal -->
    <Teleport to="body">
      <Transition name="fade">
        <div v-if="showShareModal" class="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm" @click.self="showShareModal = false">
          <div class="dk-app dk-card dk-note-in w-full max-w-md p-5" @click.stop>
            <div class="mb-4 flex items-center justify-between">
              <h3 class="dk-text text-lg font-bold">{{ t('status.share') }}</h3>
              <button
                class="dk-pill-btn !px-2.5"
                :aria-label="t('common.close')"
                @click="showShareModal = false"
              >
                ✕
              </button>
            </div>
            <div class="flex gap-2">
              <input
                type="text"
                readonly
                :value="shareUrl"
                class="dk-share-url-input dk-input flex-1 select-all"
                @focus="($event.target as HTMLInputElement).select()"
              />
              <button
                class="dk-btn-accent flex-shrink-0 !text-[13px]"
                @click="copyShareUrl"
              >
                {{ shareCopied ? t('common.copied') : t('status.copyLink') }}
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- Image Viewer Modal -->
    <ImageViewer
      v-if="showImageViewer && displayStatus.media_attachments?.length"
      :images="displayStatus.media_attachments.map((a: any) => ({ url: a.url, description: a.description || undefined, type: a.type }))"
      :initial-index="imageViewerIndex"
      @close="showImageViewer = false"
    />
  </article>
</template>

<style scoped>
/* Square-tile avatar per the Deck mockup — Avatar renders a rounded-full img */
.dk-avatar :deep(img) {
  border-radius: 13px;
  height: 100%;
  width: 100%;
}
</style>
