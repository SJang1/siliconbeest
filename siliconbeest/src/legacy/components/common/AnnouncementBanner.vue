<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Announcement } from '@/types/mastodon'
import { getAnnouncements, dismissAnnouncement } from '@/api/mastodon/instance'
import { useAuthStore } from '@/stores/auth'

const { t } = useI18n()
const auth = useAuthStore()

const announcements = ref<Announcement[]>([])
const currentIndex = ref(0)
const dismissing = ref(false)

const active = computed(() => {
  const list = announcements.value.filter(a => !a.read)
  return list.length > 0 ? list : announcements.value
})

const current = computed(() => active.value[currentIndex.value] ?? null)
const total = computed(() => active.value.length)

function prev() {
  if (currentIndex.value > 0) currentIndex.value--
}

function next() {
  if (currentIndex.value < total.value - 1) currentIndex.value++
}

async function dismiss() {
  if (!current.value || !auth.token || dismissing.value) return
  dismissing.value = true
  try {
    await dismissAnnouncement(current.value.id, auth.token)
    current.value.read = true
    // Move to next or remove
    const remaining = announcements.value.filter(a => !a.read)
    if (remaining.length === 0) {
      announcements.value = []
    } else {
      currentIndex.value = Math.min(currentIndex.value, remaining.length - 1)
    }
  } catch { /* ignore */ }
  finally { dismissing.value = false }
}

onMounted(async () => {
  try {
    const { data } = await getAnnouncements(auth.token ?? undefined)
    announcements.value = data
  } catch { /* ignore */ }
})
</script>

<template>
  <div v-if="current" class="bg-indigo-600 dark:bg-indigo-700 text-white">
    <div class="px-4 py-3 flex items-center gap-3">
      <!-- Navigation -->
      <button
        v-if="total > 1"
        @click="prev"
        :disabled="currentIndex === 0"
        class="p-1 rounded hover:bg-indigo-500 disabled:opacity-30 flex-shrink-0"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg>
      </button>

      <!-- Content -->
      <div class="flex-1 min-w-0 text-sm" v-html="current.content" />

      <!-- Counter -->
      <span v-if="total > 1" class="text-xs opacity-75 flex-shrink-0">
        {{ currentIndex + 1 }}/{{ total }}
      </span>

      <!-- Navigation -->
      <button
        v-if="total > 1"
        @click="next"
        :disabled="currentIndex === total - 1"
        class="p-1 rounded hover:bg-indigo-500 disabled:opacity-30 flex-shrink-0"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
      </button>

      <!-- Dismiss -->
      <button
        v-if="auth.isAuthenticated"
        @click="dismiss"
        :disabled="dismissing"
        class="p-1 rounded hover:bg-indigo-500 flex-shrink-0 opacity-75 hover:opacity-100"
        :title="t('common.dismiss')"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
      </button>
    </div>
  </div>
</template>
