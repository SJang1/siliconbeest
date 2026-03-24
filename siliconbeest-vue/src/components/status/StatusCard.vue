<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import type { Status } from '@/types/mastodon'
import { useStatusesStore } from '@/stores/statuses'
import { useTimelinesStore } from '@/stores/timelines'
import { useAuthStore } from '@/stores/auth'
import { useAccountsStore } from '@/stores/accounts'
import Avatar from '../common/Avatar.vue'
import StatusContent from './StatusContent.vue'
import StatusActions from './StatusActions.vue'
import MediaGallery from './MediaGallery.vue'
import PreviewCard from './PreviewCard.vue'
import ReportDialog from '../common/ReportDialog.vue'
import ImageViewer from '../common/ImageViewer.vue'

const { t } = useI18n()
const router = useRouter()
const statusesStore = useStatusesStore()
const timelinesStore = useTimelinesStore()
const authStore = useAuthStore()

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

const showReportDialog = ref(false)
const showImageViewer = ref(false)
const imageViewerIndex = ref(0)

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
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
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
  for (const emoji of emojis) {
    const pattern = new RegExp(`:${emoji.shortcode}:`, 'g')
    name = name.replace(
      pattern,
      `<img src="${emoji.url}" alt=":${emoji.shortcode}:" title=":${emoji.shortcode}:" class="custom-emoji" draggable="false" style="display:inline;height:1.2em;width:auto;vertical-align:middle;margin:0 0.05em;" />`
    )
  }
  return name
})

const hasAccountEmojis = computed(() => {
  return (displayStatus.value.account.emojis?.length ?? 0) > 0
})

const replyToDisplay = computed(() => {
  // Try to find the reply-to account from mentions
  if (props.status.mentions?.length) {
    const mention = props.status.mentions.find(
      (m: any) => m.id === props.status.in_reply_to_account_id
    )
    if (mention) return `@${(mention as any).acct || (mention as any).username}`
  }
  // Fallback: if replying to self
  if (props.status.in_reply_to_account_id === props.status.account.id) {
    return `@${props.status.account.acct}`
  }
  // Try accounts cache
  const accountsStore = useAccountsStore()
  const cached = accountsStore.getCached(props.status.in_reply_to_account_id!)
  if (cached) return `@${cached.acct}`
  // Async fetch (will update on next render)
  if (props.status.in_reply_to_account_id) {
    accountsStore.getAccount(props.status.in_reply_to_account_id)
  }
  return '...'
})

function handleFavourite() {
  // For reblogs, favourite the original status
  const target = props.status.reblog ?? props.status
  statusesStore.toggleFavourite(target)
}

function handleReblog() {
  const target = props.status.reblog ?? props.status
  statusesStore.toggleReblog(target)
}

function handleBookmark() {
  const target = props.status.reblog ?? props.status
  statusesStore.toggleBookmark(target)
}

function handleReply() {
  // For reblogs, reply to the original status, not the reblog wrapper
  const target = props.status.reblog ?? props.status
  router.push(`/@${target.account.acct}/${target.id}`)
}

async function handleShare() {
  const url = props.status.url || `${window.location.origin}/@${props.status.account.acct}/${props.status.id}`
  if (navigator.share) {
    try {
      await navigator.share({ url })
    } catch {
      // User cancelled or share failed
    }
  } else {
    await navigator.clipboard.writeText(url)
  }
}

function handleEdit() {
  // Use text field if available, otherwise strip HTML from content
  editText.value = props.status.text || ''
  editSpoilerText.value = props.status.spoiler_text || ''
  editSensitive.value = props.status.sensitive || false
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
}>()

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
    class="px-4 py-3 border-b border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
    :aria-label="t('status.by', { name: displayStatus.account.display_name })"
  >
    <!-- Reblog indicator -->
    <div v-if="isReblog" class="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 mb-2 ml-12">
      <svg class="w-3.5 h-3.5 flex-shrink-0 text-green-500" fill="currentColor" viewBox="0 0 24 24">
        <path d="M23.77 15.67a.749.749 0 00-1.06 0l-2.22 2.22V7.65a3.755 3.755 0 00-3.75-3.75h-5.85a.75.75 0 000 1.5h5.85a2.25 2.25 0 012.25 2.25v10.24l-2.22-2.22a.749.749 0 10-1.06 1.06l3.5 3.5c.145.147.337.22.53.22s.383-.072.53-.22l3.5-3.5a.747.747 0 000-1.06zm-10.66 1.47H7.26a2.25 2.25 0 01-2.25-2.25V4.65l2.22 2.22a.744.744 0 001.06 0 .749.749 0 000-1.06l-3.5-3.5a.747.747 0 00-1.06 0l-3.5 3.5a.749.749 0 101.06 1.06l2.22-2.22v10.24a3.755 3.755 0 003.75 3.75h5.85a.75.75 0 000-1.5z"/>
      </svg>
      <router-link :to="`/@${status.account.acct}`" class="font-semibold hover:underline">
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
      >
        {{ t('status.repliedTo', { user: replyToDisplay }) }}
      </router-link>
      <span v-else>{{ t('status.repliedTo', { user: '...' }) }}</span>
    </div>

    <div class="flex gap-3">
      <!-- Avatar -->
      <router-link :to="`/@${displayStatus.account.acct}`" class="flex-shrink-0">
        <Avatar :src="displayStatus.account.avatar" :alt="displayStatus.account.display_name" size="md" />
      </router-link>

      <div class="flex-1 min-w-0">
        <!-- Header -->
        <div class="flex items-center gap-1 text-sm">
          <router-link :to="`/@${displayStatus.account.acct}`" class="font-bold hover:underline truncate">
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

          <!-- Media -->
          <MediaGallery
            v-if="displayStatus.media_attachments?.length"
            :attachments="displayStatus.media_attachments"
            class="mt-2"
            @expand="openImageViewer"
          />

          <!-- Preview Card -->
          <PreviewCard
            v-if="displayStatus.card && !displayStatus.media_attachments?.length"
            :card="displayStatus.card"
          />
        </template>

        <!-- Actions -->
        <StatusActions
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

    <!-- Image Viewer Modal -->
    <ImageViewer
      v-if="showImageViewer && displayStatus.media_attachments?.length"
      :images="displayStatus.media_attachments.map((a: any) => ({ url: a.url, description: a.description || undefined, type: a.type }))"
      :initial-index="imageViewerIndex"
      @close="showImageViewer = false"
    />
  </article>
</template>
