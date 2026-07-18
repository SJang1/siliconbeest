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
import StatusEngagementDialog from '@/components/status/StatusEngagementDialog.vue'
import ReportDialog from '../common/ReportDialog.vue'
import ImageViewer from '../common/ImageViewer.vue'
import { emojifyPlainText } from '@/utils/customEmoji'
import { canUseAuthenticatedActions, getStatusActionPermissions } from '@/utils/permissions'
import { blockAccount, muteAccount } from '@/api/mastodon/accounts'
import { articleTimelinePreview } from '@/utils/articlePreview'

const { t } = useI18n()
const router = useRouter()
const statusesStore = useStatusesStore()
const timelinesStore = useTimelinesStore()
const authStore = useAuthStore()
const accountsStore = useAccountsStore()
const composeStore = useComposeStore()
const uiStore = useUiStore()
const { now } = useNow()

const props = withDefaults(defineProps<{
  status: Status
  expanded?: boolean
}>(), {
  expanded: false,
})

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

const isArticle = computed(() => displayStatus.value.object_type === 'Article')
const showArticleBody = computed(() => !isArticle.value || props.expanded)
const articlePreview = computed(() => articleTimelinePreview(
  displayStatus.value.article_summary,
  displayStatus.value.content,
))
const quotedArticlePreview = computed(() => {
  const quote = displayStatus.value.quote
  return quote?.object_type === 'Article'
    ? articleTimelinePreview(quote.article_summary, quote.content)
    : ''
})

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

async function handleEdit() {
  if (!statusActionPermissions.value.edit) return
  if (await composeStore.beginEditing(displayStatus.value)) {
    uiStore.openComposeModal()
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
    v-if="displayStatus.content || displayStatus.title || isReblog || displayStatus.media_attachments?.length"
    class="px-4 py-3 border-b border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors cursor-pointer"
    :aria-label="t('status.by', { name: displayStatus.account.display_name })"
    @click="handleCardClick"
  >
    <!-- Reblog indicator -->
    <div v-if="isReblog" class="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 mb-2 ml-12">
      <svg class="w-3.5 h-3.5 flex-shrink-0 text-green-500" fill="currentColor" viewBox="0 0 24 24">
        <path d="M23.77 15.67a.749.749 0 00-1.06 0l-2.22 2.22V7.65a3.755 3.755 0 00-3.75-3.75h-5.85a.75.75 0 000 1.5h5.85a2.25 2.25 0 012.25 2.25v10.24l-2.22-2.22a.749.749 0 10-1.06 1.06l3.5 3.5c.145.147.337.22.53.22s.383-.072.53-.22l3.5-3.5a.747.747 0 000-1.06zm-10.66 1.47H7.26a2.25 2.25 0 01-2.25-2.25V4.65l2.22 2.22a.744.744 0 001.06 0 .749.749 0 000-1.06l-3.5-3.5a.747.747 0 00-1.06 0l-3.5 3.5a.749.749 0 101.06 1.06l2.22-2.22v10.24a3.755 3.755 0 003.75 3.75h5.85a.75.75 0 000-1.5z"/>
      </svg>
      <router-link :to="`/@${cachedStatus.account.acct}`" class="font-semibold hover:underline" @click.stop>
        {{ cachedStatus.account.display_name || cachedStatus.account.username }}
      </router-link>
      <span>{{ t('status.reblogged') }}</span>
    </div>

    <!-- Reply indicator -->
    <div v-if="displayStatus.in_reply_to_id" class="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 mb-1 ml-12">
      <svg class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"/>
      </svg>
      <router-link
        v-if="displayStatus.in_reply_to_account_id"
        :to="displayStatus.in_reply_to_id ? `/@${displayStatus.account.acct}/${displayStatus.in_reply_to_id}` : '#'"
        class="hover:underline"
        @click.stop
      >
        {{ t('status.repliedTo', { user: replyToDisplay }) }}
      </router-link>
      <span v-else>{{ t('status.repliedTo', { user: '...' }) }}</span>
    </div>

    <div class="flex gap-3">
      <!-- Avatar -->
      <router-link :to="`/@${displayStatus.account.acct}`" class="flex-shrink-0 w-10 h-10" @click.stop>
        <Avatar :src="displayStatus.account.avatar" :alt="displayStatus.account.display_name" size="md" />
      </router-link>

      <div class="flex-1 min-w-0">
        <!-- Header -->
        <div class="flex items-center gap-1 text-sm">
          <router-link :to="`/@${displayStatus.account.acct}`" class="font-bold hover:underline truncate" @click.stop>
            <span v-if="hasAccountEmojis" v-html="emojifiedDisplayName" />
            <template v-else>{{ displayStatus.account.display_name || displayStatus.account.username }}</template>
          </router-link>
          <span class="text-gray-500 dark:text-gray-400 truncate">@{{ displayStatus.account.acct }}</span>
          <span class="text-gray-400 dark:text-gray-500 mx-1" aria-hidden="true">&middot;</span>
          <time :datetime="displayStatus.created_at" class="text-gray-500 dark:text-gray-400 text-xs whitespace-nowrap">
            {{ relativeTime }}
          </time>
          <span
            v-if="displayStatus.visibility && displayStatus.visibility !== 'public'"
            class="text-xs ml-1"
            :class="{
              'text-blue-500 dark:text-blue-400': displayStatus.visibility === 'unlisted',
              'text-green-500 dark:text-green-400': displayStatus.visibility === 'private',
              'text-yellow-500 dark:text-yellow-400': displayStatus.visibility === 'direct',
            }"
            :title="t(`status.visibility_${displayStatus.visibility}`)"
          >
            <template v-if="displayStatus.visibility === 'unlisted'">🔓</template>
            <template v-else-if="displayStatus.visibility === 'private'">🔒</template>
            <template v-else-if="displayStatus.visibility === 'direct'">✉️</template>
          </span>
          <span v-if="displayStatus.edited_at" class="text-gray-400 dark:text-gray-500 text-xs ml-1" :title="displayStatus.edited_at">
            ({{ t('status.edited') }})
          </span>
        </div>

        <!-- Content display -->
            <h2
            v-if="displayStatus.object_type === 'Article' && displayStatus.title"
            class="mt-2 text-xl font-bold leading-snug text-gray-950 dark:text-white"
            >{{ displayStatus.title }}</h2>
            <p
              v-if="isArticle && (expanded ? displayStatus.article_summary : (!displayStatus.sensitive && articlePreview))"
              data-testid="article-preview"
              class="mt-1.5 whitespace-pre-line text-sm leading-relaxed text-slate-500 dark:text-slate-400"
              :class="{ 'line-clamp-4': !displayStatus.article_summary }"
            >{{ expanded ? displayStatus.article_summary : articlePreview }}</p>
          <StatusContent
            v-if="showArticleBody"
            :content="displayStatus.content"
            :spoiler-text="displayStatus.spoiler_text"
            :sensitive="displayStatus.sensitive"
            :emojis="displayStatus.emojis"
            :hide-quote-inline="!!displayStatus.quote"
          />

          <!-- Poll -->
          <StatusPoll
            v-if="showArticleBody && displayStatus.poll"
            :poll="displayStatus.poll"
            @updated="handlePollUpdate"
            @click.stop
          />

          <!-- Media -->
          <MediaGallery
            v-if="showArticleBody && displayStatus.media_attachments?.length"
            :attachments="displayStatus.media_attachments"
            class="mt-2"
            @expand="openImageViewer"
            @click.stop
          />

          <!-- Preview Card -->
          <PreviewCard
            v-if="showArticleBody && displayStatus.card && !displayStatus.media_attachments?.length"
            :card="displayStatus.card"
            @click.stop
          />

          <div
            v-if="showArticleBody && displayStatus.quote"
            class="mt-3 border border-gray-200 dark:border-gray-700 rounded-lg p-3 hover:bg-gray-50 dark:hover:bg-gray-800"
            @click.stop="emit('navigate', displayStatus.quote)"
          >
            <div class="flex items-center gap-1 text-sm min-w-0">
              <span class="font-semibold truncate">{{ displayStatus.quote.account.display_name || displayStatus.quote.account.username }}</span>
              <span class="text-gray-500 dark:text-gray-400 truncate">@{{ displayStatus.quote.account.acct }}</span>
            </div>
            <h3
              v-if="displayStatus.quote.object_type === 'Article' && displayStatus.quote.title"
              class="mt-2 font-bold text-gray-950 dark:text-white"
            >{{ displayStatus.quote.title }}</h3>
            <p
              v-if="displayStatus.quote.object_type === 'Article'"
              class="mt-1.5 whitespace-pre-line text-sm leading-relaxed text-gray-500 line-clamp-3 dark:text-gray-400"
            >{{ quotedArticlePreview }}</p>
            <StatusContent
              v-else
              :content="displayStatus.quote.content"
              :spoiler-text="displayStatus.quote.spoiler_text"
              :sensitive="displayStatus.quote.sensitive"
              :emojis="displayStatus.quote.emojis"
            />
            <div
              v-if="displayStatus.quote.object_type === 'Article'"
              class="mt-2 border-t border-gray-200 pt-2 text-center text-xs font-semibold text-indigo-600 dark:border-gray-700 dark:text-indigo-400"
            >{{ t('status.read_full_article') }}</div>
          </div>

          <router-link
            v-if="isArticle && !expanded"
            :to="`/@${displayStatus.account.acct}/${displayStatus.id}`"
            data-testid="read-full-article"
            class="mt-3 flex w-full items-center justify-center rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm font-semibold text-indigo-600 transition-colors hover:border-indigo-300 hover:bg-indigo-50 dark:border-gray-700 dark:bg-gray-800 dark:text-indigo-400 dark:hover:border-indigo-700 dark:hover:bg-indigo-950/30"
            @click.stop
          >
            {{ t('status.read_full_article') }}
          </router-link>
        <!-- 이모지 리액션 -->
        <StatusReactions
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
      variant="legacy"
      @click.stop
      @close="engagementKind = null"
    />

    <!-- Share Modal -->
    <Teleport to="body">
      <Transition name="fade">
        <div v-if="showShareModal" class="fixed inset-0 bg-black/50 z-[70] flex items-center justify-center p-4" @click.self="showShareModal = false">
          <div class="bg-white dark:bg-gray-800 rounded-2xl shadow-xl w-full max-w-md p-5" @click.stop>
            <div class="flex items-center justify-between mb-4">
              <h3 class="text-lg font-bold text-gray-900 dark:text-white">{{ t('status.share') }}</h3>
              <button @click="showShareModal = false" class="p-1 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
              </button>
            </div>
            <div class="flex gap-2">
              <input
                type="text"
                readonly
                :value="shareUrl"
                class="share-url-input flex-1 px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-900 text-sm text-gray-900 dark:text-gray-100 select-all focus:outline-none focus:ring-2 focus:ring-indigo-500"
                @focus="($event.target as HTMLInputElement).select()"
              />
              <button
                @click="copyShareUrl"
                class="px-4 py-2 rounded-lg text-sm font-medium transition-colors flex-shrink-0"
                :class="shareCopied
                  ? 'bg-green-600 text-white'
                  : 'bg-indigo-600 hover:bg-indigo-700 text-white'"
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
