<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Relationship } from '@/types/mastodon'
import { useAuthStore } from '@/stores/auth'
import { useTimelinesStore } from '@/stores/timelines'
import { blockAccount, unblockAccount, muteAccount, unmuteAccount } from '@/api/mastodon/accounts'
import Avatar from '../common/Avatar.vue'
import FollowButton from './FollowButton.vue'
import ReportDialog from '../common/ReportDialog.vue'
import { emojifyHtml, emojifyPlainText } from '@/utils/customEmoji'
import { canUseAuthenticatedActions } from '@/utils/permissions'

const { t } = useI18n()

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

const emojiClass = 'custom-emoji inline-block h-5 max-w-8 align-text-bottom'
const emojifiedName = computed(() => emojifyPlainText(props.account.display_name || props.account.acct, props.account.emojis, emojiClass))
const emojifiedNote = computed(() => emojifyHtml(props.account.note || '', props.account.emojis, emojiClass))
const emojifiedFields = computed(() => (props.account.fields ?? []).map((field) => ({
  ...field,
  nameHtml: emojifyPlainText(field.name, props.account.emojis, emojiClass),
  valueHtml: emojifyHtml(field.value, props.account.emojis, emojiClass),
})))

const auth = useAuthStore()
const timelinesStore = useTimelinesStore()
const accountCanAct = computed(() => canUseAuthenticatedActions({
  authenticated: auth.isAuthenticated,
  accountLoaded: auth.currentUser !== null,
  accountSuspended: auth.currentUser?.suspended,
  accountMemorial: auth.currentUser?.memorial,
}))

const emit = defineEmits<{
  'toggle-follow': []
  'relationship-updated': [relationship: Relationship]
}>()

const showMoreMenu = ref(false)
const showReportDialog = ref(false)
const actionLoading = ref(false)

function openReport() {
  if (!accountCanAct.value || props.isOwn) return
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
  if (!accountCanAct.value || props.isOwn || !auth.token || actionLoading.value) return
  showMoreMenu.value = false
  actionLoading.value = true
  try {
    const wasBlocking = !!props.relationship?.blocking
    const fn = wasBlocking ? unblockAccount : blockAccount
    const { data } = await fn(props.account.id, auth.token)
    emit('relationship-updated', data as Relationship)
    if (!wasBlocking) timelinesStore.removeAccountStatuses(props.account.id)
  } catch (e) {
    console.error('Block toggle failed:', e)
  } finally {
    actionLoading.value = false
  }
}

async function toggleMute() {
  if (!accountCanAct.value || props.isOwn || !auth.token || actionLoading.value) return
  showMoreMenu.value = false
  actionLoading.value = true
  try {
    const wasMuting = !!props.relationship?.muting
    const fn = wasMuting ? unmuteAccount : muteAccount
    const { data } = await fn(props.account.id, auth.token)
    emit('relationship-updated', data as Relationship)
    if (!wasMuting) timelinesStore.removeAccountStatuses(props.account.id)
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
  <div class="sb-card animate-rise-in">
    <!-- Banner -->
    <div class="relative h-48 overflow-hidden rounded-t-[calc(1rem-1px)] bg-linear-to-br from-brand-500 via-violet-500 to-fuchsia-400 dark:from-brand-800 dark:via-violet-800 dark:to-fuchsia-700">
      <img
        v-if="account.header"
        :src="account.header"
        :alt="t('profile.banner')"
        class="h-full w-full object-cover"
      />
      <!-- Blocked overlay on banner -->
      <div v-if="!isOwn && relationship?.blocking" class="absolute inset-0 flex items-center justify-center bg-black/60 backdrop-blur-sm">
        <div class="flex items-center gap-2 rounded-full bg-red-600/90 px-4 py-2 text-sm font-semibold text-white shadow-lift">
          <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" /></svg>
          {{ t('profile.blocked_banner') }}
        </div>
      </div>
    </div>

    <!-- Profile info -->
    <div class="relative px-5 pb-5">
      <!-- Avatar + follow button row -->
      <div class="-mt-14 mb-3 flex items-end justify-between">
        <div class="sb-avatar-ring relative z-10 shadow-lift ring-4 ring-surface dark:ring-surface-dark">
          <Avatar :src="account.avatar" :alt="account.display_name" size="xl" />
        </div>
        <div class="flex items-center gap-2 pt-16">
          <span
            v-if="!isOwn && relationship?.followed_by"
            class="sb-chip"
          >{{ t('profile.follows_you') }}</span>
          <FollowButton
            v-if="accountCanAct && !isOwn"
            :account-id="account.id"
            :following="relationship?.following"
            :requested="relationship?.requested"
            :blocked="relationship?.blocking"
            @toggle="handleToggle"
          />
          <!-- More menu for non-own accounts -->
          <div v-if="accountCanAct && !isOwn" class="relative" @focusout="onMenuFocusOut">
            <button
              type="button"
              @click="showMoreMenu = !showMoreMenu"
              class="sb-btn sb-btn-secondary h-9 w-9 p-0"
              :aria-label="t('status.more_actions')"
            >
              <svg class="h-5 w-5" fill="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="12" cy="19" r="1.5" /></svg>
            </button>
            <div
              v-if="showMoreMenu"
              class="sb-menu absolute right-0 top-full z-50 mt-2 w-52 animate-fade-in"
            >
              <button
                @click="toggleBlock"
                class="sb-menu-item"
                :class="relationship?.blocking ? '' : 'text-red-600 dark:text-red-400'"
              >
                <svg class="h-4 w-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" /></svg>
                {{ relationship?.blocking ? t('profile.unblock_user', { user: account.acct }) : t('profile.block_user', { user: account.acct }) }}
              </button>
              <button
                @click="toggleMute"
                class="sb-menu-item"
                :class="relationship?.muting ? '' : 'text-amber-600 dark:text-amber-400'"
              >
                <svg class="h-4 w-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" /></svg>
                {{ relationship?.muting ? t('profile.unmute_user', { user: account.acct }) : t('profile.mute_user', { user: account.acct }) }}
              </button>
              <button
                @click="openReport"
                class="sb-menu-item text-red-600 dark:text-red-400"
              >
                <svg class="h-4 w-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3 21v-4m0 0V5a2 2 0 012-2h6.5l1 1H21l-3 6 3 6h-8.5l-1-1H5a2 2 0 00-2 2z" /></svg>
                {{ t('profile.report_user') }}
              </button>
            </div>
          </div>
          <router-link
            v-if="accountCanAct && isOwn"
            to="/settings/profile"
            class="sb-btn sb-btn-secondary"
          >
            {{ t('profile.edit') }}
          </router-link>
        </div>
      </div>

      <!-- Name -->
      <h1 class="sb-heading text-xl text-slate-900 dark:text-white" v-html="emojifiedName" />
      <p class="text-sm text-slate-500 dark:text-slate-400">@{{ account.acct }}</p>
      <span
        v-if="remoteDomain"
        class="mt-1.5 inline-flex items-center gap-1 rounded-full bg-surface-2 px-2.5 py-0.5 text-xs font-medium text-slate-500 dark:bg-surface-2-dark dark:text-slate-400"
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
      <dl v-if="emojifiedFields.length" class="mt-4 divide-y divide-outline overflow-hidden rounded-xl border border-outline dark:divide-outline-dark dark:border-outline-dark">
        <div
          v-for="field in emojifiedFields"
          :key="field.name"
          class="flex text-sm"
        >
          <dt class="w-1/3 truncate bg-surface-2 px-3 py-2 font-semibold text-slate-600 dark:bg-surface-2-dark dark:text-slate-300" v-html="field.nameHtml" />
          <dd
            class="flex-1 truncate px-3 py-2"
            :class="field.verified_at ? 'font-medium text-emerald-600 dark:text-emerald-400' : 'text-slate-700 dark:text-slate-200'"
            v-html="field.valueHtml"
          />
        </div>
      </dl>

      <!-- Stats -->
      <div class="mt-4 flex flex-wrap items-center gap-2">
        <router-link :to="`/@${account.acct}`" class="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1 text-xs font-medium text-slate-500 transition-colors hover:bg-brand-50 hover:text-brand-700 dark:bg-surface-2-dark dark:text-slate-400 dark:hover:bg-brand-950/50 dark:hover:text-brand-300">
          <span class="text-sm font-bold text-slate-900 dark:text-white">{{ formatStat(account.statuses_count) }}</span>
          <span>{{ t('profile.posts') }}</span>
        </router-link>
        <router-link :to="`/@${account.acct}/following`" class="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1 text-xs font-medium text-slate-500 transition-colors hover:bg-brand-50 hover:text-brand-700 dark:bg-surface-2-dark dark:text-slate-400 dark:hover:bg-brand-950/50 dark:hover:text-brand-300">
          <span class="text-sm font-bold text-slate-900 dark:text-white">{{ formatStat(account.following_count) }}</span>
          <span>{{ t('profile.following') }}</span>
        </router-link>
        <router-link :to="`/@${account.acct}/followers`" class="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1 text-xs font-medium text-slate-500 transition-colors hover:bg-brand-50 hover:text-brand-700 dark:bg-surface-2-dark dark:text-slate-400 dark:hover:bg-brand-950/50 dark:hover:text-brand-300">
          <span class="text-sm font-bold text-slate-900 dark:text-white">{{ formatStat(account.followers_count) }}</span>
          <span>{{ t('profile.followers') }}</span>
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
