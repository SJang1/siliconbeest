<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Relationship } from '@/types/mastodon'
import { useAuthStore } from '@/stores/auth'
import { blockAccount, unblockAccount, muteAccount, unmuteAccount } from '@/api/mastodon/accounts'
import Avatar from '../common/Avatar.vue'
import FollowButton from './FollowButton.vue'
import ReportDialog from '../common/ReportDialog.vue'

const { t } = useI18n()

/** Replace :shortcode: with <img> for custom emojis */
function emojifyText(text: string, emojis?: Array<{ shortcode: string; url: string; static_url: string }>): string {
  if (!emojis || emojis.length === 0 || !text) return text
  // Deduplicate by shortcode to prevent double-replacement
  const seen = new Set<string>()
  const uniqueEmojis = emojis.filter(e => {
    if (seen.has(e.shortcode)) return false
    seen.add(e.shortcode)
    return true
  })
  let result = text
  for (const e of uniqueEmojis) {
    // Use negative lookbehind/lookahead to avoid matching inside HTML attributes
    // Simple approach: replace only :shortcode: that are NOT inside quotes
    const escaped = e.shortcode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    result = result.replace(
      new RegExp(`(?<!=")\\u200B?:${escaped}:\\u200B?`, 'g'),
      `<img src="${e.url}" alt="${e.shortcode}" title="${e.shortcode}" class="inline-block h-5 w-5 align-text-bottom" draggable="false" />`
    )
  }
  return result
}

const props = defineProps<{
  account: {
    id: string
    avatar: string
    header: string
    display_name: string
    acct: string
    note: string
    statuses_count: number
    following_count: number
    followers_count: number
    fields?: Array<{ name: string; value: string; verified_at?: string | null }>
    emojis?: Array<{ shortcode: string; url: string; static_url: string }>
  }
  isOwn?: boolean
  relationship?: Relationship
}>()

const emojifiedName = computed(() => emojifyText(props.account.display_name || props.account.acct, props.account.emojis))
const emojifiedNote = computed(() => emojifyText(props.account.note || '', props.account.emojis))

const auth = useAuthStore()

const emit = defineEmits<{
  'toggle-follow': []
  'relationship-updated': [relationship: Relationship]
}>()

const showMoreMenu = ref(false)
const showReportDialog = ref(false)
const actionLoading = ref(false)

function openReport() {
  showMoreMenu.value = false
  showReportDialog.value = true
}

function onMenuFocusOut(e: FocusEvent) {
  const container = e.currentTarget as HTMLElement
  if (!container?.contains(e.relatedTarget as Node)) {
    showMoreMenu.value = false
  }
}

async function toggleBlock() {
  if (!auth.token || actionLoading.value) return
  showMoreMenu.value = false
  actionLoading.value = true
  try {
    const fn = props.relationship?.blocking ? unblockAccount : blockAccount
    const { data } = await fn(props.account.id, auth.token)
    emit('relationship-updated', data as Relationship)
  } catch (e) {
    console.error('Block toggle failed:', e)
  } finally {
    actionLoading.value = false
  }
}

async function toggleMute() {
  if (!auth.token || actionLoading.value) return
  showMoreMenu.value = false
  actionLoading.value = true
  try {
    const fn = props.relationship?.muting ? unmuteAccount : muteAccount
    const { data } = await fn(props.account.id, auth.token)
    emit('relationship-updated', data as Relationship)
  } catch (e) {
    console.error('Mute toggle failed:', e)
  } finally {
    actionLoading.value = false
  }
}

const remoteDomain = computed(() => {
  const acct = props.account.acct
  const atIndex = acct.indexOf('@')
  return atIndex !== -1 ? acct.substring(atIndex + 1) : null
})

function formatStat(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

function handleToggle() {
  emit('toggle-follow')
}
</script>

<template>
  <div>
    <!-- Banner -->
    <div class="h-48 relative overflow-hidden" :class="account.header ? '' : 'bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-400 dark:from-indigo-700 dark:via-purple-700 dark:to-pink-600'">
      <img
        v-if="account.header"
        :src="account.header"
        :alt="t('profile.banner')"
        class="w-full h-full object-cover"
      />
    </div>

    <!-- Blocked banner -->
    <div v-if="!isOwn && relationship?.blocking" class="px-4 py-3 bg-red-50 dark:bg-red-900/20 border-b border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-300 flex items-center gap-2">
      <svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" /></svg>
      {{ t('profile.blocked_banner') }}
    </div>

    <!-- Profile info -->
    <div class="px-4 pb-4 relative">
      <!-- Avatar + follow button row -->
      <div class="flex items-end justify-between -mt-16 mb-3">
        <Avatar :src="account.avatar" :alt="account.display_name" size="xl"
          class="ring-4 ring-white dark:ring-gray-900 relative z-10"
        />
        <div class="flex items-center gap-2 pt-16">
          <span
            v-if="!isOwn && relationship?.followed_by"
            class="text-xs px-2 py-0.5 rounded bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300"
          >{{ t('profile.follows_you') }}</span>
          <FollowButton
            v-if="!isOwn"
            :account-id="account.id"
            :following="relationship?.following"
            :requested="relationship?.requested"
            :blocked="relationship?.blocking"
            @toggle="handleToggle"
          />
          <!-- More menu for non-own accounts -->
          <div v-if="!isOwn" class="relative" @focusout="onMenuFocusOut">
            <button
              type="button"
              @click="showMoreMenu = !showMoreMenu"
              class="p-2 rounded-full border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              :aria-label="t('status.more_actions')"
            >
              <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="12" cy="19" r="1.5" /></svg>
            </button>
            <div
              v-if="showMoreMenu"
              class="absolute right-0 top-full mt-1 w-44 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50 py-1"
            >
              <button
                @click="toggleBlock"
                class="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
                :class="relationship?.blocking ? 'text-gray-700 dark:text-gray-200' : 'text-red-600 dark:text-red-400'"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" /></svg>
                {{ relationship?.blocking ? t('profile.unblock_user', { user: account.acct }) : t('profile.block_user', { user: account.acct }) }}
              </button>
              <button
                @click="toggleMute"
                class="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
                :class="relationship?.muting ? 'text-gray-700 dark:text-gray-200' : 'text-orange-600 dark:text-orange-400'"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" /></svg>
                {{ relationship?.muting ? t('profile.unmute_user', { user: account.acct }) : t('profile.mute_user', { user: account.acct }) }}
              </button>
              <button
                @click="openReport"
                class="w-full text-left px-4 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3 21v-4m0 0V5a2 2 0 012-2h6.5l1 1H21l-3 6 3 6h-8.5l-1-1H5a2 2 0 00-2 2z" /></svg>
                {{ t('profile.report_user') }}
              </button>
            </div>
          </div>
          <router-link
            v-if="isOwn"
            to="/settings/profile"
            class="px-4 py-1.5 rounded-full border border-gray-300 dark:border-gray-600 text-sm font-bold hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            {{ t('profile.edit') }}
          </router-link>
        </div>
      </div>

      <!-- Name -->
      <h1 class="text-xl font-bold" v-html="emojifiedName" />
      <p class="text-gray-500 dark:text-gray-400 text-sm">@{{ account.acct }}</p>
      <span
        v-if="remoteDomain"
        class="inline-flex items-center gap-1 text-xs bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded-full text-gray-500 mt-1"
      >
        🌐 {{ remoteDomain }}
      </span>

      <!-- Bio -->
      <div
        v-if="account.note"
        class="prose prose-sm dark:prose-invert max-w-none mt-3"
        v-html="emojifiedNote"
      />

      <!-- Fields -->
      <dl v-if="account.fields?.length" class="mt-3 space-y-1">
        <div
          v-for="field in account.fields"
          :key="field.name"
          class="flex text-sm border border-gray-200 dark:border-gray-700 rounded overflow-hidden"
        >
          <dt class="px-3 py-1.5 bg-gray-50 dark:bg-gray-800 font-medium w-1/3 truncate">{{ field.name }}</dt>
          <dd
            class="px-3 py-1.5 flex-1 truncate"
            :class="{ 'text-green-600 dark:text-green-400': field.verified_at }"
            v-html="field.value"
          />
        </div>
      </dl>

      <!-- Stats -->
      <div class="flex gap-4 mt-4 text-sm">
        <router-link :to="`/@${account.acct}`" class="hover:underline">
          <span class="font-bold">{{ formatStat(account.statuses_count) }}</span>
          <span class="text-gray-500 dark:text-gray-400 ml-1">{{ t('profile.posts') }}</span>
        </router-link>
        <router-link :to="`/@${account.acct}/following`" class="hover:underline">
          <span class="font-bold">{{ formatStat(account.following_count) }}</span>
          <span class="text-gray-500 dark:text-gray-400 ml-1">{{ t('profile.following') }}</span>
        </router-link>
        <router-link :to="`/@${account.acct}/followers`" class="hover:underline">
          <span class="font-bold">{{ formatStat(account.followers_count) }}</span>
          <span class="text-gray-500 dark:text-gray-400 ml-1">{{ t('profile.followers') }}</span>
        </router-link>
      </div>
    </div>

    <!-- Report dialog -->
    <ReportDialog
      :open="showReportDialog"
      :account-id="account.id"
      :account-acct="account.acct"
      @close="showReportDialog = false"
    />
  </div>
</template>
