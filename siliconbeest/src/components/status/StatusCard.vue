<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import type { Status } from '@/types/mastodon'
import { useStatusesStore } from '@/stores/statuses'
import { useTimelinesStore } from '@/stores/timelines'
import { useAuthStore } from '@/stores/auth'
import { useAccountsStore } from '@/stores/accounts'
import { useComposeStore } from '@/stores/compose'
import { useUiStore } from '@/stores/ui'
import { useNow } from '@/composables/useNow'
import Avatar from '../common/Avatar.vue'
import StatusContent from './StatusContent.vue'
import StatusActions from './StatusActions.vue'
import MediaGallery from './MediaGallery.vue'
import PreviewCard from './PreviewCard.vue'
import StatusPoll from './StatusPoll.vue'
import StatusReactions from './StatusReactions.vue'
import StatusEngagementDialog from './StatusEngagementDialog.vue'
import ReportDialog from '../common/ReportDialog.vue'
import ImageViewer from '../common/ImageViewer.vue'
import { emojifyPlainText } from '@/utils/customEmoji'
import { canUseAuthenticatedActions, getStatusActionPermissions } from '@/utils/permissions'
import { blockAccount, muteAccount } from '@/api/mastodon/accounts'

const { t } = useI18n()
const router = useRouter()
const statusesStore = useStatusesStore()
const timelinesStore = useTimelinesStore()
const authStore = useAuthStore()
const accountsStore = useAccountsStore()
const composeStore = useComposeStore()
const uiStore = useUiStore()
const { now } = useNow()

const props = defineProps<{
  status: Status
}>()

// Resolve status from the store cache so optimistic updates are reactive
const cachedStatus = computed(() => statusesStore.getCached(props.status.id) ?? props.status)

// If this is a reblog, show the original status content
// A status is a reblog wrapper when content is empty and reblog exists
const isReblog = computed(() => !!cachedStatus.value.reblog)
const displayStatus = computed(() => {
  if (cachedStatus.value.reblog) {
    // Also resolve the inner reblog from cache
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
  // now.value is a reactive timestamp that updates every 30 seconds,
  // ensuring this computed re-evaluates periodically
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

const replyToDisplay = computed(() => {
  const status = displayStatus.value
  // Try to find the reply-to account from mentions
  if (status.mentions?.length) {
    const mention = status.mentions.find(
      (m: any) => m.id === status.in_reply_to_account_id
    )
    if (mention) return `@${(mention as any).acct || (mention as any).username}`
  }
  // Fallback: if replying to self
  if (status.in_reply_to_account_id === status.account.id) {
    return `@${status.account.acct}`
  }
  // Try accounts cache
  const cached = accountsStore.getCached(status.in_reply_to_account_id!)
  if (cached) return `@${cached.acct}`
  // Async fetch (will update on next render)
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
  // For reblogs, reply to the original status, not the reblog wrapper
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
  // Show share modal with copyable link
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
    // Fallback: select input text
    const input = document.querySelector('.share-url-input') as HTMLInputElement
    if (input) {
      input.select()
      document.execCommand('copy')
      shareCopied.value = true
      setTimeout(() => { shareCopied.value = false }, 2000)
    }
  }
}

function stripHtml(html: string): string {
  // Convert <br> and </p><p> to newlines, then strip remaining tags
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
  // Use text field if available, otherwise strip HTML from content
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

const emit = defineEmits<{
  reply: [status: Status]
  deleted: [statusId: string]
  navigate: [status: Status]
}>()

function handlePollUpdate(updatedPoll: Status['poll']) {
  const target = cachedStatus.value.reblog ?? cachedStatus.value
  if (updatedPoll) {
    statusesStore.cacheStatus({ ...target, poll: updatedPoll })
  }
}

// 리액션 업데이트 시 캐시 갱신
function handleReactionUpdate(updatedStatus: Status) {
  statusesStore.cacheStatus(updatedStatus)
}

// 액션 메뉴의 "이모지로 반응" → 리액션 이모지 피커 열기 (좋아요 버튼을 앵커로 사용)
const reactionsRef = ref<InstanceType<typeof StatusReactions> | null>(null)
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
    class="cursor-pointer border-b border-outline px-4 py-3.5 transition-colors hover:bg-surface-2/60 dark:border-outline-dark dark:hover:bg-surface-2-dark/40 sm:px-5"
    :aria-label="t('status.by', { name: displayStatus.account.display_name })"
    @click="handleCardClick"
  >
    <!-- Reblog indicator -->
    <div v-if="isReblog" class="mb-2 ml-[3.25rem] flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
      <svg class="h-4 w-4 flex-shrink-0 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M19.5 12c0-1.232-.046-2.453-.138-3.662a4.006 4.006 0 00-3.7-3.7 48.678 48.678 0 00-7.324 0 4.006 4.006 0 00-3.7 3.7c-.017.22-.032.441-.046.662M19.5 12l3-3m-3 3l-3-3m-12 3c0 1.232.046 2.453.138 3.662a4.006 4.006 0 003.7 3.7 48.656 48.656 0 007.324 0 4.006 4.006 0 003.7-3.7c.017-.22.032-.441.046-.662M4.5 12l-3 3m3-3l3 3"/>
      </svg>
      <router-link :to="`/@${cachedStatus.account.acct}`" class="truncate font-semibold text-slate-600 transition-colors hover:text-brand-600 hover:underline dark:text-slate-300 dark:hover:text-brand-400" @click.stop>
        {{ cachedStatus.account.display_name || cachedStatus.account.username }}
      </router-link>
      <span class="flex-shrink-0">{{ t('status.reblogged') }}</span>
    </div>

    <!-- Reply indicator -->
    <div v-if="displayStatus.in_reply_to_id" class="mb-1.5 ml-[3.25rem] flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
      <svg class="h-4 w-4 flex-shrink-0 text-brand-500 dark:text-brand-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3"/>
      </svg>
      <router-link
        v-if="displayStatus.in_reply_to_account_id"
        :to="displayStatus.in_reply_to_id ? `/@${displayStatus.account.acct}/${displayStatus.in_reply_to_id}` : '#'"
        class="truncate transition-colors hover:text-brand-600 hover:underline dark:hover:text-brand-400"
        @click.stop
      >
        {{ t('status.repliedTo', { user: replyToDisplay }) }}
      </router-link>
      <span v-else class="truncate">{{ t('status.repliedTo', { user: '...' }) }}</span>
    </div>

    <div class="flex gap-3">
      <!-- Avatar -->
      <router-link
        :to="`/@${displayStatus.account.acct}`"
        class="h-10 w-10 flex-shrink-0 rounded-full ring-2 ring-transparent transition duration-150 hover:ring-brand-400/60 dark:hover:ring-brand-500/50"
        @click.stop
      >
        <Avatar :src="displayStatus.account.avatar" :alt="displayStatus.account.display_name" size="md" />
      </router-link>

      <div class="min-w-0 flex-1">
        <!-- Header -->
        <div class="flex min-w-0 items-center gap-1.5 text-sm">
          <router-link :to="`/@${displayStatus.account.acct}`" class="min-w-0 truncate font-semibold text-slate-900 hover:underline dark:text-slate-50" @click.stop>
            <span v-if="hasAccountEmojis" v-html="emojifiedDisplayName" />
            <template v-else>{{ displayStatus.account.display_name || displayStatus.account.username }}</template>
          </router-link>
          <span class="min-w-0 truncate text-slate-500 dark:text-slate-400">@{{ displayStatus.account.acct }}</span>
          <span class="flex-shrink-0 text-slate-300 dark:text-slate-600" aria-hidden="true">&middot;</span>
          <time :datetime="displayStatus.created_at" class="flex-shrink-0 whitespace-nowrap text-xs text-slate-400 dark:text-slate-500">
            {{ relativeTime }}
          </time>
          <span
            v-if="displayStatus.visibility && displayStatus.visibility !== 'public'"
            class="ml-0.5 inline-flex flex-shrink-0 items-center"
            :class="{
              'text-sky-500 dark:text-sky-400': displayStatus.visibility === 'unlisted',
              'text-emerald-500 dark:text-emerald-400': displayStatus.visibility === 'private',
              'text-amber-500 dark:text-amber-400': displayStatus.visibility === 'direct',
            }"
            :title="t(`status.visibility_${displayStatus.visibility}`)"
          >
            <template v-if="displayStatus.visibility === 'unlisted'"><svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M13.5 10.5V6.75a4.5 4.5 0 119 0v3.75M3.75 21.75h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H3.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"/></svg></template>
            <template v-else-if="displayStatus.visibility === 'private'"><svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"/></svg></template>
            <template v-else-if="displayStatus.visibility === 'direct'"><svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75"/></svg></template>
          </span>
          <span v-if="displayStatus.edited_at" class="ml-0.5 flex-shrink-0 text-xs text-slate-400 dark:text-slate-500" :title="displayStatus.edited_at">
            ({{ t('status.edited') }})
          </span>
        </div>

        <!-- Edit mode -->
        <div v-if="isEditing" class="mt-2 space-y-2">
          <div class="text-xs font-semibold uppercase tracking-wide text-brand-600 dark:text-brand-400">
            {{ t('status.editing') }}
          </div>
          <textarea
            v-model="editText"
            class="sb-input resize-none"
            rows="3"
          />
          <input
            v-if="displayStatus.spoiler_text"
            v-model="editSpoilerText"
            type="text"
            :placeholder="t('compose.cw_placeholder')"
            class="sb-input"
          />
          <!-- Existing media attachments preview -->
          <div v-if="displayStatus.media_attachments?.length" class="flex flex-wrap gap-2">
            <div
              v-for="media in displayStatus.media_attachments"
              :key="media.id"
              class="relative h-20 w-20 overflow-hidden rounded-xl border border-outline dark:border-outline-dark"
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
              @click="submitEdit"
              :disabled="editLoading || !editText.trim()"
              class="sb-btn sb-btn-primary sb-btn-sm"
            >
              {{ t('common.save') }}
            </button>
            <button
              @click="cancelEdit"
              class="sb-btn sb-btn-secondary sb-btn-sm"
            >
              {{ t('common.cancel') }}
            </button>
          </div>
        </div>

        <!-- Normal content display -->
        <template v-else>
          <StatusContent
            :content="displayStatus.content"
            :spoiler-text="displayStatus.spoiler_text"
            :sensitive="displayStatus.sensitive"
            :emojis="displayStatus.emojis"
            :hide-quote-inline="!!displayStatus.quote"
          />

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
            class="mt-2"
            @expand="openImageViewer"
            @click.stop
          />

          <!-- Preview Card -->
          <PreviewCard
            v-if="displayStatus.card && !displayStatus.media_attachments?.length"
            :card="displayStatus.card"
            @click.stop
          />

          <div
            v-if="displayStatus.quote"
            class="mt-3 cursor-pointer rounded-xl border border-outline bg-surface-2/40 p-3 transition-colors hover:border-brand-200 hover:bg-surface-2/70 dark:border-outline-dark dark:bg-surface-2-dark/30 dark:hover:border-brand-800 dark:hover:bg-surface-2-dark/60"
            @click.stop="emit('navigate', displayStatus.quote)"
          >
            <div class="flex min-w-0 items-center gap-1.5 text-sm">
              <span class="truncate font-semibold text-slate-900 dark:text-slate-100">{{ displayStatus.quote.account.display_name || displayStatus.quote.account.username }}</span>
              <span class="truncate text-slate-500 dark:text-slate-400">@{{ displayStatus.quote.account.acct }}</span>
            </div>
            <StatusContent
              :content="displayStatus.quote.content"
              :spoiler-text="displayStatus.quote.spoiler_text"
              :sensitive="displayStatus.quote.sensitive"
              :emojis="displayStatus.quote.emojis"
            />
          </div>
        </template>

        <!-- 이모지 리액션 -->
        <StatusReactions
          ref="reactionsRef"
          :status="displayStatus"
          class="mt-2"
          @updated="handleReactionUpdate"
          @click.stop
        />

        <!-- Actions -->
        <StatusActions @click.stop
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
          @react="handleReact"
          @bookmark="handleBookmark"
          @reply="handleReply"
          @share="handleShare"
          @edit="handleEdit"
          @delete="handleDelete"
          @report="handleReport"
          @block="handleBlock"
          @mute="handleMute"
        />
      </div>
    </div>
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
      @click.stop
      @close="engagementKind = null"
    />

    <!-- Share Modal -->
    <Teleport to="body">
      <Transition name="fade">
        <div v-if="showShareModal" class="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm" @click.self="showShareModal = false">
          <div class="sb-card w-full max-w-md p-5 shadow-lift animate-rise-in" @click.stop>
            <div class="mb-4 flex items-center justify-between">
              <h3 class="sb-heading text-lg text-slate-900 dark:text-white">{{ t('status.share') }}</h3>
              <button
                @click="showShareModal = false"
                class="rounded-full p-1.5 text-slate-500 transition-colors hover:bg-surface-2 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 dark:text-slate-400 dark:hover:bg-surface-2-dark dark:hover:text-slate-200"
              >
                <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M6 18L18 6M6 6l12 12"/></svg>
              </button>
            </div>
            <div class="flex gap-2">
              <input
                type="text"
                readonly
                :value="shareUrl"
                class="share-url-input sb-input flex-1 select-all"
                @focus="($event.target as HTMLInputElement).select()"
              />
              <button
                @click="copyShareUrl"
                class="sb-btn flex-shrink-0"
                :class="shareCopied
                  ? 'bg-emerald-600 text-white'
                  : 'sb-btn-primary'"
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
