<script setup lang="ts">
import { computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { useAnnouncementsStore } from '@/stores/announcements'

const { t } = useI18n()
const auth = useAuthStore()
const announcements = useAnnouncementsStore()

const current = computed(() => announcements.bannerAnnouncement)

function close() {
  if (current.value) announcements.hideBanner(current.value.id)
}

watch(
  () => auth.token,
  (token) => {
    void announcements.fetch(token ?? undefined)
  },
  { immediate: true },
)
</script>

<template>
  <div v-if="current" class="flex-none bg-linear-to-r from-brand-600 via-violet-600 to-fuchsia-600 text-white dark:from-brand-800 dark:via-violet-800 dark:to-fuchsia-800">
    <div class="flex h-9 items-center gap-2 px-3 sm:px-4">
      <span aria-hidden="true">📢</span>
      <router-link to="/announcements" class="min-w-0 flex-1 text-sm text-white no-underline">
        <span class="line-clamp-1 [&_*]:m-0 [&_*]:inline [&_a]:font-medium [&_a]:text-white [&_a]:underline" v-html="current.content" />
      </router-link>
      <router-link v-if="announcements.unreadCount > 1" to="/announcements" class="shrink-0 text-xs font-semibold text-white/80 no-underline">
        +{{ announcements.unreadCount - 1 }}
      </router-link>
      <button
        type="button"
        class="shrink-0 rounded-full p-1 opacity-80 transition hover:bg-white/20 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
        :title="t('common.close')"
        :aria-label="t('common.close')"
        @click="close"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18 18 6M6 6l12 12"/></svg>
      </button>
    </div>
  </div>
</template>
