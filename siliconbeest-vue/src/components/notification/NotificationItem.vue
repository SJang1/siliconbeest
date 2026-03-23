<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Notification } from '@/types/mastodon'
import Avatar from '../common/Avatar.vue'

const { t } = useI18n()

const props = defineProps<{
  notification: Notification
}>()

const typeConfig: Record<string, { icon: string; color: string }> = {
  follow: { icon: '👤', color: 'text-indigo-600 dark:text-indigo-400' },
  favourite: { icon: '⭐', color: 'text-yellow-500' },
  reblog: { icon: '🔄', color: 'text-green-600 dark:text-green-400' },
  mention: { icon: '💬', color: 'text-blue-600 dark:text-blue-400' },
  poll: { icon: '📊', color: 'text-purple-600 dark:text-purple-400' },
  follow_request: { icon: '🔔', color: 'text-orange-500' },
}

const config = computed(() => typeConfig[props.notification.type] ?? typeConfig.mention)
</script>

<template>
  <div class="flex gap-3 px-4 py-3 border-b border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
    <!-- Type icon -->
    <div class="flex-shrink-0 w-10 flex justify-end">
      <span :class="config.color" class="text-lg" aria-hidden="true">{{ config.icon }}</span>
    </div>

    <div class="flex-1 min-w-0">
      <!-- Actor -->
      <div class="flex items-center gap-2 mb-1">
        <router-link :to="`/@${notification.account.acct}`">
          <Avatar :src="notification.account.avatar" :alt="notification.account.display_name" size="sm" />
        </router-link>
        <p class="text-sm">
          <router-link :to="`/@${notification.account.acct}`" class="font-bold hover:underline">
            {{ notification.account.display_name }}
          </router-link>
          <span class="text-gray-500 dark:text-gray-400 ml-1">
            {{ t(`notification.type.${notification.type}`) }}
          </span>
        </p>
      </div>

      <!-- Status preview -->
      <router-link
        v-if="notification.status"
        :to="`/status/${notification.status.id}`"
        class="block text-sm text-gray-600 dark:text-gray-400 line-clamp-2 mt-1"
        v-html="notification.status.content"
      />
    </div>
  </div>
</template>
