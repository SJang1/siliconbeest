<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Relationship } from '@/types/mastodon'
import { followAccount, unfollowAccount } from '@/api/mastodon/accounts'
import { useAuthStore } from '@/stores/auth'
import { useAccountsStore } from '@/stores/accounts'
import Avatar from '../common/Avatar.vue'
import FollowButton from './FollowButton.vue'
import { emojifyPlainText } from '@/utils/customEmoji'

const { t } = useI18n()
const auth = useAuthStore()
const accountsStore = useAccountsStore()

const props = defineProps<{
  account: {
    id: string
    avatar: string
    display_name: string
    acct: string
    note?: string
    emojis?: Array<{ shortcode: string; url: string; static_url: string }>
  }
  showFollowButton?: boolean
  relationship?: Relationship
}>()

const emojifiedName = computed(() => emojifyPlainText(
  props.account.display_name || props.account.acct,
  props.account.emojis,
  'custom-emoji inline-block h-5 max-w-8 align-text-bottom',
))

async function handleToggle() {
  if (!auth.token) return
  const rel = accountsStore.getRelationship(props.account.id)
  try {
    const { data } = rel?.following
      ? await unfollowAccount(props.account.id, auth.token)
      : await followAccount(props.account.id, auth.token)
    accountsStore.updateRelationship(data)
  } catch {
    // silently fail
  }
}
</script>

<template>
  <div class="flex items-center gap-3 p-3 transition-colors hover:bg-surface-2/70 dark:hover:bg-surface-2-dark/60">
    <router-link :to="`/@${account.acct}`" class="h-10 w-10 flex-shrink-0">
      <Avatar :src="account.avatar" :alt="account.display_name" size="md" />
    </router-link>

    <div class="min-w-0 flex-1">
      <router-link :to="`/@${account.acct}`" class="block">
        <p class="truncate text-sm font-semibold text-slate-900 hover:underline dark:text-slate-100" v-html="emojifiedName" />
        <p class="truncate text-xs text-slate-500 dark:text-slate-400">@{{ account.acct }}</p>
      </router-link>
    </div>

    <FollowButton
      v-if="showFollowButton"
      :account-id="account.id"
      :following="accountsStore.getRelationship(account.id)?.following"
      :requested="accountsStore.getRelationship(account.id)?.requested"
      :blocked="accountsStore.getRelationship(account.id)?.blocking"
      class="sb-btn-sm flex-shrink-0"
      @toggle="handleToggle"
    />
  </div>
</template>
