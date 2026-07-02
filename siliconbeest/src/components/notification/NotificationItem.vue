<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Notification } from '@/types/mastodon'
import Avatar from '../common/Avatar.vue'
import { emojifyPlainText } from '@/utils/customEmoji'

const { t } = useI18n()

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

// Heroicons 24 outline paths + soft tinted circle per notification type
const typeConfig: Record<string, { path: string; circle: string }> = {
  follow: {
    path: 'M18 7.5v3m0 0v3m0-3h3m-3 0h-3m-2.25-4.125a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0ZM3 19.235v-.11a6.375 6.375 0 0 1 12.75 0v.109A12.318 12.318 0 0 1 9.374 21c-2.331 0-4.512-.645-6.374-1.766Z',
    circle: 'bg-brand-100 text-brand-600 dark:bg-brand-950/60 dark:text-brand-300',
  },
  favourite: {
    path: 'M11.48 3.499a.562.562 0 0 1 1.04 0l2.125 5.111a.563.563 0 0 0 .475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 0 0-.182.557l1.285 5.385a.562.562 0 0 1-.84.61l-4.725-2.885a.562.562 0 0 0-.586 0L6.982 20.54a.562.562 0 0 1-.84-.61l1.285-5.386a.562.562 0 0 0-.182-.557l-4.204-3.602a.562.562 0 0 1 .321-.988l5.518-.442a.563.563 0 0 0 .475-.345L11.48 3.5Z',
    circle: 'bg-rose-100 text-rose-600 dark:bg-rose-950/50 dark:text-rose-300',
  },
  emoji_reaction: {
    path: 'M15.182 15.182a4.5 4.5 0 0 1-6.364 0M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM9.75 9.75c0 .414-.168.75-.375.75S9 10.164 9 9.75 9.168 9 9.375 9s.375.336.375.75Zm-.375 0h.008v.015h-.008V9.75Zm5.625 0c0 .414-.168.75-.375.75s-.375-.336-.375-.75.168-.75.375-.75.375.336.375.75Zm-.375 0h.008v.015h-.008V9.75Z',
    circle: 'bg-rose-100 text-rose-600 dark:bg-rose-950/50 dark:text-rose-300',
  },
  reblog: {
    path: 'M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99',
    circle: 'bg-green-100 text-green-600 dark:bg-green-950/50 dark:text-green-300',
  },
  mention: {
    path: 'M12 20.25c4.97 0 9-3.694 9-8.25s-4.03-8.25-9-8.25S3 7.444 3 12c0 2.104.859 4.023 2.273 5.48.432.447.74 1.04.586 1.641a4.483 4.483 0 0 1-.923 1.785A5.969 5.969 0 0 0 6 21c1.282 0 2.47-.402 3.445-1.087.81.22 1.668.337 2.555.337Z',
    circle: 'bg-brand-100 text-brand-600 dark:bg-brand-950/60 dark:text-brand-300',
  },
  poll: {
    path: 'M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z',
    circle: 'bg-brand-100 text-brand-600 dark:bg-brand-950/60 dark:text-brand-300',
  },
  follow_request: {
    path: 'M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0',
    circle: 'bg-brand-100 text-brand-600 dark:bg-brand-950/60 dark:text-brand-300',
  },
}

const fallbackConfig = {
  path: 'M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 5.25h.008v.008H12v-.008Z',
  circle: 'bg-surface-2 text-slate-500 dark:bg-surface-2-dark dark:text-slate-400',
}

// For emoji_reaction, use the actual emoji from the notification
const reactionEmoji = computed(() => (props.notification as any).emoji as string | undefined)

const config = computed(() => typeConfig[props.notification.type] ?? fallbackConfig)
</script>

<template>
  <div
    @click="handleClick"
    class="relative flex cursor-pointer gap-3 border-b border-outline/70 px-4 py-3 transition-colors hover:bg-surface-2/70 dark:border-outline-dark/70 dark:hover:bg-surface-2-dark/50"
    :class="{ 'bg-brand-50/50 dark:bg-brand-950/20': !(notification as any).read }"
  >
    <!-- Unread brand accent -->
    <span
      v-if="!(notification as any).read"
      class="absolute inset-y-2 left-0 w-0.5 rounded-full bg-brand-500 dark:bg-brand-400"
      aria-hidden="true"
    ></span>

    <!-- Type icon -->
    <div class="flex w-10 flex-shrink-0 justify-end">
      <span
        class="flex h-9 w-9 items-center justify-center rounded-full"
        :class="config.circle"
        aria-hidden="true"
      >
        <template v-if="notification.type === 'emoji_reaction' && reactionEmoji">
          <img
            v-if="(notification as any).emoji_url && reactionEmoji.startsWith(':')"
            :src="(notification as any).emoji_url"
            :alt="reactionEmoji"
            class="inline-block h-5 w-5"
          />
          <span v-else class="text-base leading-none">{{ reactionEmoji }}</span>
        </template>
        <svg v-else class="h-[1.125rem] w-[1.125rem]" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" :d="config.path" />
        </svg>
      </span>
    </div>

    <div class="flex-1 min-w-0">
      <!-- Actor -->
      <div class="flex items-center gap-2 mb-1">
        <router-link :to="`/@${notification.account.acct}`" class="flex-shrink-0 w-8 h-8">
          <Avatar :src="notification.account.avatar" :alt="notification.account.display_name" size="sm" />
        </router-link>
        <p class="text-sm">
          <router-link :to="`/@${notification.account.acct}`" class="font-semibold text-slate-900 hover:underline dark:text-slate-100">
            <span v-html="emojifyPlainText(notification.account.display_name || notification.account.username, notification.account.emojis, 'custom-emoji inline-block h-4 max-w-6 align-text-bottom')" />
          </router-link>
          <span class="ml-1 text-slate-500 dark:text-slate-400">
            {{ t(`notification.${notification.type}`) }}
          </span>
        </p>
      </div>

      <!-- Status preview -->
      <router-link
        v-if="notification.status"
        :to="`/@${notification.account.acct}/${notification.status.id}`"
        class="mt-1 block text-sm text-slate-500 line-clamp-2 dark:text-slate-400"
        v-html="notification.status.content"
      />
    </div>
  </div>
</template>
