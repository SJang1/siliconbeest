import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { Announcement } from '@/types/mastodon'
import { dismissAnnouncement, getAnnouncements } from '@/api/mastodon/instance'

export const useAnnouncementsStore = defineStore('announcements', () => {
  const items = ref<Announcement[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  const loadedForToken = ref<string | null>(null)
  const loadingForToken = ref<string | null>(null)
  const hiddenFromBanner = ref<Set<string>>(new Set())
  let latestRequest = 0

  const unreadItems = computed(() => items.value.filter((announcement) => !announcement.read))
  const unreadCount = computed(() => unreadItems.value.length)
  const bannerAnnouncement = computed(() =>
    unreadItems.value.find((announcement) => !hiddenFromBanner.value.has(announcement.id)) ?? null,
  )

  async function fetch(token?: string, force = false) {
    const cacheKey = token ?? '__public__'
    if (!force && (loadedForToken.value === cacheKey || loadingForToken.value === cacheKey)) return
    const request = ++latestRequest
    loading.value = true
    loadingForToken.value = cacheKey
    error.value = null

    try {
      const { data } = await getAnnouncements(token)
      if (request !== latestRequest) return
      items.value = data
      loadedForToken.value = cacheKey
    } catch (cause) {
      if (request !== latestRequest) return
      error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      if (request === latestRequest) {
        loading.value = false
        loadingForToken.value = null
      }
    }
  }

  function hideBanner(id: string) {
    hiddenFromBanner.value = new Set([...hiddenFromBanner.value, id])
  }

  async function markRead(id: string, token: string) {
    const announcement = items.value.find((item) => item.id === id)
    if (!announcement || announcement.read) return

    await dismissAnnouncement(id, token)
    announcement.read = true
  }

  async function markAllRead(token: string) {
    const unreadIds = unreadItems.value.map((announcement) => announcement.id)
    await Promise.all(unreadIds.map((id) => markRead(id, token)))
  }

  function reset() {
    items.value = []
    error.value = null
    loadedForToken.value = null
    loadingForToken.value = null
    hiddenFromBanner.value = new Set()
  }

  return {
    items,
    loading,
    error,
    unreadItems,
    unreadCount,
    bannerAnnouncement,
    fetch,
    hideBanner,
    markRead,
    markAllRead,
    reset,
  }
})
