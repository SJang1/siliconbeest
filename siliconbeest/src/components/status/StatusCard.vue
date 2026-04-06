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
import ReportDialog from '../common/ReportDialog.vue'
import ImageViewer from '../common/ImageViewer.vue'

const { t } = useI18n()
const router = useRouter()
const statusesStore = useStatusesStore()
const timelinesStore = useTimelinesStore()
const authStore = useAuthStore()
const composeStore = useComposeStore()
const uiStore = useUiStore()
const { now } = useNow()

const props = defineProps<{
  status: Status
}>()

// If this is a reblog, show the original status content
// A status is a reblog wrapper when content is empty and reblog exists
const isReblog = computed(() => !!props.status.reblog)
const displayStatus = computed(() => {
  if (props.status.reblog) return props.status.reblog
  // Fallback: if content is empty, it might be a reblog whose inner data wasn't loaded
  return props.status
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

function openImageViewer(index: number) {
  imageViewerIndex.value = index
  showImageViewer.value = true
}
const reportTarget = ref<{ accountId: string; accountAcct: string; statusId: string } | null>(null)

function handleReport(payload: { accountId: string; accountAcct: string; statusId: string }) {
  reportTarget.value = payload
  showReportDialog.value = true
}

const isOwnStatus = computed(() => {
  return authStore.currentUser?.id === displayStatus.value.account.id
})

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

/** Replace :shortcode: in text with <img> tags using account emojis */
const emojifiedDisplayName = computed(() => {
  let name = displayStatus.value.account.display_name || ''
  const emojis = displayStatus.value.account.emojis
  if (!emojis || emojis.length === 0) return name
  name = name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  // Deduplicate by shortcode
  const seen = new Set<string>()
  for (const emoji of emojis) {
    if (seen.has(emoji.shortcode)) continue
    seen.add(emoji.shortcode)
    const escaped = emoji.shortcode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    name = name.replace(
      new RegExp(`\\u200B?:${escaped}:\\u200B?`, 'g'),
      `<img src="${emoji.url}" alt="${emoji.shortcode}" title="${emoji.shortcode}" class="custom-emoji" draggable="false" style="display:inline;height:1.2em;width:auto;vertical-align:middle;margin:0 0.05em;" />`
    )
  }
  return name
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
  const accountsStore = useAccountsStore()
  const cached = accountsStore.getCached(status.in_reply_to_account_id!)
  if (cached) return `@${cached.acct}`
  // Async fetch (will update on next render)
  if (status.in_reply_to_account_id) {
    accountsStore.getAccount(status.in_reply_to_account_id)
  }
  return '...'
})

async function handleFavourite() {
  if (loadingFavourite.value) return
  loadingFavourite.value = true
  try {
    const target = props.status.reblog ?? props.status
    await statusesStore.toggleFavourite(target)
  } finally {
    loadingFavourite.value = false
  }
}

async function handleReblog() {
  if (loadingReblog.value) return
  loadingReblog.value = true
  try {
    const target = props.status.reblog ?? props.status
    await statusesStore.toggleReblog(target)
  } finally {
    loadingReblog.value = false
  }
}

async function handleBookmark() {
  if (loadingBookmark.value) return
  loadingBookmark.value = true
  try {
    const target = props.status.reblog ?? props.status
    await statusesStore.toggleBookmark(target)
  } finally {
    loadingBookmark.value = false
  }
}

function handleReply() {
  // For reblogs, reply to the original status, not the reblog wrapper
  const target = props.status.reblog ?? props.status
  composeStore.setReplyTo(target)
  uiStore.openComposeModal()
}

function handleCardClick() {
  const target = props.status.reblog ?? props.status
  emit('navigate', target)
}

async function handleShare() {
  const url = props.status.url || `${window.location.origin}/@${props.status.account.acct}/${props.status.id}`
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
  if (editLoading.value) return
  editLoading.value = true
  try {
    await statusesStore.editStatus(props.status.id, {
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
  const target = props.status.reblog ?? props.status
  if (updatedPoll) {
    statusesStore.cacheStatus({ ...target, poll: updatedPoll })
  }
}

// 리액션 업데이트 시 캐시 갱신
function handleReactionUpdate(updatedStatus: Status) {
  statusesStore.cacheStatus(updatedStatus)
}

async function handleDelete() {
  if (!confirm(t('status.delete_confirm'))) return
  try {
    await statusesStore.deleteStatus(props.status.id)
    timelinesStore.removeStatus(props.status.id)
    emit('deleted', props.status.id)
  } catch {
    // Error handling
  }
}
</script>

<template>
  <article
    v-if="displayStatus.content || isReblog || displayStatus.media_attachments?.length"
    class="px-4 py-3 border-b border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors cursor-pointer"
    :aria-label="t('status.by', { name: displayStatus.account.display_name })"
    @click="handleCardClick"
  >
    <!-- Reblog indicator -->
    <div v-if="isReblog" class="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 mb-2 ml-12">
      <svg class="w-3.5 h-3.5 flex-shrink-0 text-green-500" fill="currentColor" viewBox="0 0 24 24">
        <path d="M23.77 15.67a.749.749 0 00-1.06 0l-2.22 2.22V7.65a3.755 3.755 0 00-3.75-3.75h-5.85a.75.75 0 000 1.5h5.85a2.25 2.25 0 012.25 2.25v10.24l-2.22-2.22a.749.749 0 10-1.06 1.06l3.5 3.5c.145.147.337.22.53.22s.383-.072.53-.22l3.5-3.5a.747.747 0 000-1.06zm-10.66 1.47H7.26a2.25 2.25 0 01-2.25-2.25V4.65l2.22 2.22a.744.744 0 001.06 0 .749.749 0 000-1.06l-3.5-3.5a.747.747 0 00-1.06 0l-3.5 3.5a.749.749 0 101.06 1.06l2.22-2.22v10.24a3.755 3.755 0 003.75 3.75h5.85a.75.75 0 000-1.5z"/>
      </svg>
      <router-link :to="`/@${status.account.acct}`" class="font-semibold hover:underline" @click.stop>
        {{ status.account.display_name || status.account.username }}
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

        <!-- Edit mode -->
        <div v-if="isEditing" class="mt-2">
          <div class="text-xs font-medium text-indigo-600 dark:text-indigo-400 mb-1">
            {{ t('status.editing') }}
          </div>
          <textarea
            v-model="editText"
            class="w-full border border-gray-300 dark:border-gray-600 rounded-lg p-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 resize-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            rows="3"
          />
          <input
            v-if="displayStatus.spoiler_text"
            v-model="editSpoilerText"
            type="text"
            :placeholder="t('compose.cw_placeholder')"
            class="w-full mt-1 border border-gray-300 dark:border-gray-600 rounded-lg p-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          />
          <!-- Existing media attachments preview -->
          <div v-if="displayStatus.media_attachments?.length" class="flex gap-2 mt-2 flex-wrap">
            <div
              v-for="media in displayStatus.media_attachments"
              :key="media.id"
              class="relative w-20 h-20 rounded-lg overflow-hidden border border-gray-300 dark:border-gray-600"
            >
              <img
                :src="media.preview_url || media.url"
                :alt="media.description || ''"
                class="w-full h-full object-cover"
              />
            </div>
          </div>
          <div class="flex items-center gap-2 mt-2">
            <button
              @click="submitEdit"
              :disabled="editLoading || !editText.trim()"
              class="px-3 py-1 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {{ t('common.save') }}
            </button>
            <button
              @click="cancelEdit"
              class="px-3 py-1 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600"
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
        </template>

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
          :is-own-status="isOwnStatus"
          :account-id="displayStatus.account.id"
          :account-acct="displayStatus.account.acct"
          :visibility="displayStatus.visibility"
          :loading-favourite="loadingFavourite"
          :loading-reblog="loadingReblog"
          :loading-bookmark="loadingBookmark"
          class="mt-2"
          @favourite="handleFavourite"
          @reblog="handleReblog"
          @bookmark="handleBookmark"
          @reply="handleReply"
          @share="handleShare"
          @edit="handleEdit"
          @delete="handleDelete"
          @report="handleReport"
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

<style scoped>
.fade-enter-active, .fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from, .fade-leave-to {
  opacity: 0;
}
</style>
