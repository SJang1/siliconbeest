<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import Avatar from '../common/Avatar.vue'
import FollowButton from './FollowButton.vue'

const { t } = useI18n()

defineProps<{
  account: {
    id: string
    avatar: string
    display_name: string
    acct: string
    note?: string
  }
  showFollowButton?: boolean
}>()
</script>

<template>
  <div class="flex items-center gap-3 p-3 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
    <router-link :to="`/@${account.acct}`" class="flex-shrink-0">
      <Avatar :src="account.avatar" :alt="account.display_name" size="md" />
    </router-link>

    <div class="flex-1 min-w-0">
      <router-link :to="`/@${account.acct}`" class="block">
        <p class="font-semibold text-sm truncate hover:underline">{{ account.display_name }}</p>
        <p class="text-xs text-gray-500 dark:text-gray-400 truncate">@{{ account.acct }}</p>
      </router-link>
    </div>

    <FollowButton
      v-if="showFollowButton"
      :account-id="account.id"
      class="flex-shrink-0"
    />
  </div>
</template>
