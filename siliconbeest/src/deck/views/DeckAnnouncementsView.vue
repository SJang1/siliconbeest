<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import DeckPageShell from '../layout/DeckPageShell.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import { useAnnouncementsStore } from '@/stores/announcements'
import { useAuthStore } from '@/stores/auth'

const { t, locale } = useI18n()
const auth = useAuthStore()
const announcements = useAnnouncementsStore()
const readingIds = ref<Set<string>>(new Set())
const markingAll = ref(false)
const actionError = ref<string | null>(null)

const dateFormatter = computed(() => new Intl.DateTimeFormat(locale.value, {
  dateStyle: 'medium',
  timeStyle: 'short',
}))

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : dateFormatter.value.format(date)
}

async function markRead(id: string) {
  if (!auth.token || readingIds.value.has(id)) return
  readingIds.value = new Set([...readingIds.value, id])
  actionError.value = null
  try {
    await announcements.markRead(id, auth.token)
  } catch (cause) {
    actionError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    const next = new Set(readingIds.value)
    next.delete(id)
    readingIds.value = next
  }
}

async function markAllRead() {
  if (!auth.token || markingAll.value) return
  markingAll.value = true
  actionError.value = null
  try {
    await announcements.markAllRead(auth.token)
  } catch (cause) {
    actionError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    markingAll.value = false
  }
}

watch(
  () => auth.token,
  (token) => {
    if (token) void announcements.fetch(token)
  },
  { immediate: true },
)
</script>

<template>
  <DeckPageShell width="feed">
    <div class="min-h-full px-3 pb-24 pt-3 md:px-0 md:pb-8 md:pt-0">
      <header class="dk-card mb-3 flex items-center justify-between gap-3 px-4 py-3.5">
        <div class="min-w-0">
          <h1 class="dk-text text-lg font-bold">📢 {{ t('nav.announcements') }}</h1>
          <p v-if="announcements.unreadCount > 0" class="dk-dim-text mt-0.5 text-xs">
            {{ t('announcement.unread_count', { count: announcements.unreadCount }) }}
          </p>
        </div>
        <button
          v-if="announcements.unreadCount > 0"
          type="button"
          class="dk-btn-accent shrink-0"
          :disabled="markingAll"
          @click="markAllRead"
        >
          {{ t('announcement.mark_all_read') }}
        </button>
      </header>

      <div v-if="announcements.loading && announcements.items.length === 0" class="flex justify-center py-16">
        <LoadingSpinner />
      </div>

      <div v-else-if="announcements.error && announcements.items.length === 0" class="dk-card px-5 py-10 text-center">
        <p class="mb-3 text-sm text-red-500">{{ announcements.error }}</p>
        <button type="button" class="dk-pill-btn" @click="auth.token && announcements.fetch(auth.token, true)">
          {{ t('common.retry') }}
        </button>
      </div>

      <div v-else-if="announcements.items.length === 0" class="dk-card dk-dim-text px-5 py-12 text-center text-sm">
        <div class="mb-2 text-3xl" aria-hidden="true">📭</div>
        <p class="dk-text font-semibold">{{ t('announcement.empty') }}</p>
        <p class="mt-1">{{ t('announcement.empty_hint') }}</p>
      </div>

      <div v-else class="space-y-3">
        <article
          v-for="announcement in announcements.items"
          :key="announcement.id"
          class="dk-card overflow-hidden"
          :class="announcement.read ? '' : 'ring-1 ring-[var(--dk-acc)]'"
        >
          <div class="flex items-center justify-between gap-3 border-b border-[var(--dk-line)] px-4 py-2.5">
            <div class="flex min-w-0 items-center gap-2">
              <span v-if="!announcement.read" class="h-2 w-2 shrink-0 rounded-full bg-[var(--dk-acc)]" aria-hidden="true" />
              <span class="dk-mono dk-dim-text truncate text-xs">{{ formatDate(announcement.published_at) }}</span>
            </div>
            <span v-if="announcement.read" class="dk-dim-text shrink-0 text-xs">{{ t('announcement.read') }}</span>
            <button
              v-else
              type="button"
              class="dk-pill-btn shrink-0"
              :disabled="readingIds.has(announcement.id)"
              @click="markRead(announcement.id)"
            >
              {{ t('announcement.mark_read') }}
            </button>
          </div>
          <div class="dk-text px-4 py-4 text-sm leading-relaxed [&_a]:text-[var(--dk-acc)] [&_a]:underline [&_p]:my-2" v-html="announcement.content" />
        </article>
      </div>

      <p v-if="actionError" class="mt-3 text-center text-sm text-red-500">{{ actionError }}</p>
    </div>
  </DeckPageShell>
</template>
