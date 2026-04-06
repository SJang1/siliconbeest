<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Notification } from '@/types/mastodon'
import Avatar from '../common/Avatar.vue'

const { t } = useI18n()

function emojifyText(text: string, emojis?: Array<{ shortcode: string; url: string }>): string {
  if (!emojis || emojis.length === 0 || !text) return text
  let r = text
  for (const e of emojis) r = r.replace(new RegExp(`:${e.shortcode}:`, 'g'), `<img src="${e.url}" alt=":${e.shortcode}:" class="inline-block h-4 w-4 align-text-bottom" draggable="false" />`)
  return r
}

const props = defineProps<{
  notification: Notification
}>()

const emit = defineEmits<{
  'mark-read': [id: string]
}>()

function handleClick() {
  if (!(props.notification as any).read) {
    emit('mark-read', props.notification.id)
  }
}

const typeConfig: Record<string, { icon: string; color: string }> = {
  follow: { icon: '👤', color: 'text-indigo-600 dark:text-indigo-400' },
  favourite: { icon: '⭐', color: 'text-yellow-500' },
  emoji_reaction: { icon: '😀', color: 'text-yellow-500' },
  reblog: { icon: '🔄', color: 'text-green-600 dark:text-green-400' },
  mention: { icon: '💬', color: 'text-blue-600 dark:text-blue-400' },
  poll: { icon: '📊', color: 'text-purple-600 dark:text-purple-400' },
  follow_request: { icon: '🔔', color: 'text-orange-500' },
}

// For emoji_reaction, use the actual emoji from the notification
const reactionEmoji = computed(() => (props.notification as any).emoji as string | undefined)

const config = computed(() => {
  const base = typeConfig[props.notification.type] ?? { icon: '?', color: 'text-gray-500' }
  // Override icon with actual emoji for reactions
  if (props.notification.type === 'emoji_reaction' && reactionEmoji.value) {
    return { ...base, icon: reactionEmoji.value }
  }
  return base
})
</script>

<template>
  <div
    @click="handleClick"
    class="flex gap-3 px-4 py-3 border-b border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors cursor-pointer"
    :class="{ 'bg-indigo-50/50 dark:bg-indigo-900/10': !(notification as any).read }"
  >
    <!-- Type icon -->
    <div class="flex-shrink-0 w-10 flex justify-end">
      <span :class="config.color" class="text-lg" aria-hidden="true">
        <template v-if="notification.type === 'emoji_reaction' && reactionEmoji?.startsWith(':')">
          <img
            v-if="(notification as any).emoji_url"
            :src="(notification as any).emoji_url"
            :alt="reactionEmoji"
            class="inline-block w-5 h-5"
          />
          <span v-else>{{ reactionEmoji }}</span>
        </template>
        <template v-else>{{ config.icon }}</template>
      </span>
    </div>

    <div class="flex-1 min-w-0">
      <!-- Actor -->
      <div class="flex items-center gap-2 mb-1">
        <router-link :to="`/@${notification.account.acct}`" class="flex-shrink-0 w-8 h-8">
          <Avatar :src="notification.account.avatar" :alt="notification.account.display_name" size="sm" />
        </router-link>
        <p class="text-sm">
          <router-link :to="`/@${notification.account.acct}`" class="font-bold hover:underline">
            <span v-html="emojifyText(notification.account.display_name || notification.account.username, notification.account.emojis)" />
          </router-link>
          <span class="text-gray-500 dark:text-gray-400 ml-1">
            {{ t(`notification.${notification.type}`) }}
          </span>
        </p>
      </div>

      <!-- Status preview -->
      <router-link
        v-if="notification.status"
        :to="`/@${notification.account.acct}/${notification.status.id}`"
        class="block text-sm text-gray-600 dark:text-gray-400 line-clamp-2 mt-1"
        v-html="notification.status.content"
      />
    </div>
  </div>
</template>
