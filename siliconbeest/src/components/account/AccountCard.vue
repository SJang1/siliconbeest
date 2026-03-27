<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Relationship } from '@/types/mastodon'
import { followAccount, unfollowAccount } from '@/api/mastodon/accounts'
import { useAuthStore } from '@/stores/auth'
import { useAccountsStore } from '@/stores/accounts'
import Avatar from '../common/Avatar.vue'
import FollowButton from './FollowButton.vue'

const { t } = useI18n()
const auth = useAuthStore()
const accountsStore = useAccountsStore()

function emojifyText(text: string, emojis?: Array<{ shortcode: string; url: string }>): string {
  if (!emojis || emojis.length === 0 || !text) return text
  let r = text
  for (const e of emojis) r = r.replace(new RegExp(`:${e.shortcode}:`, 'g'), `<img src="${e.url}" alt=":${e.shortcode}:" class="inline-block h-5 w-5 align-text-bottom" draggable="false" />`)
  return r
}

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

const emojifiedName = computed(() => emojifyText(props.account.display_name || props.account.acct, props.account.emojis))

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
  <div class="flex items-center gap-3 p-3 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
    <router-link :to="`/@${account.acct}`" class="flex-shrink-0">
      <Avatar :src="account.avatar" :alt="account.display_name" size="md" />
    </router-link>

    <div class="flex-1 min-w-0">
      <router-link :to="`/@${account.acct}`" class="block">
        <p class="font-semibold text-sm truncate hover:underline" v-html="emojifiedName" />
        <p class="text-xs text-gray-500 dark:text-gray-400 truncate">@{{ account.acct }}</p>
      </router-link>
    </div>

    <FollowButton
      v-if="showFollowButton"
      :account-id="account.id"
      :following="accountsStore.getRelationship(account.id)?.following"
      :requested="accountsStore.getRelationship(account.id)?.requested"
      :blocked="accountsStore.getRelationship(account.id)?.blocking"
      class="flex-shrink-0"
      @toggle="handleToggle"
    />
  </div>
</template>
