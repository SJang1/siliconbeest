<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import Avatar from '../common/Avatar.vue'
import FollowButton from './FollowButton.vue'

const { t } = useI18n()

defineProps<{
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
    fields?: Array<{ name: string; value: string; verified_at?: string }>
  }
  isOwn?: boolean
}>()

function formatStat(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}
</script>

<template>
  <div>
    <!-- Banner -->
    <div class="h-48 bg-gray-200 dark:bg-gray-700 relative">
      <img
        v-if="account.header"
        :src="account.header"
        :alt="t('profile.banner')"
        class="w-full h-full object-cover"
      />
    </div>

    <!-- Profile info -->
    <div class="px-4 pb-4">
      <!-- Avatar + follow button row -->
      <div class="flex items-end justify-between -mt-12 mb-3">
        <Avatar :src="account.avatar" :alt="account.display_name" size="xl"
          class="ring-4 ring-white dark:ring-gray-900"
        />
        <div class="flex gap-2 mt-14">
          <FollowButton v-if="!isOwn" :account-id="account.id" />
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
      <h1 class="text-xl font-bold">{{ account.display_name }}</h1>
      <p class="text-gray-500 dark:text-gray-400 text-sm">@{{ account.acct }}</p>

      <!-- Bio -->
      <div
        v-if="account.note"
        class="prose prose-sm dark:prose-invert max-w-none mt-3"
        v-html="account.note"
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
  </div>
</template>
