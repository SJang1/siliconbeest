import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { Announcement } from '@/types/mastodon'
import { useAnnouncementsStore } from '@/stores/announcements'
import { dismissAnnouncement, getAnnouncements } from '@/api/mastodon/instance'

vi.mock('@/api/mastodon/instance', () => ({
  getAnnouncements: vi.fn(),
  dismissAnnouncement: vi.fn(),
}))

function makeAnnouncement(id: string, read = false): Announcement {
  return {
    id,
    content: `Announcement ${id}`,
    starts_at: null,
    ends_at: null,
    all_day: false,
    published_at: '2026-07-16T00:00:00.000Z',
    updated_at: '2026-07-16T00:00:00.000Z',
    read,
    mentions: [],
    statuses: [],
    tags: [],
    emojis: [],
    reactions: [],
  }
}

describe('Announcements Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.mocked(dismissAnnouncement).mockResolvedValue({ data: {}, headers: new Headers() })
  })

  it('counts unread announcements returned for the signed-in user', async () => {
    vi.mocked(getAnnouncements).mockResolvedValue({
      data: [makeAnnouncement('unread'), makeAnnouncement('read', true)],
      headers: new Headers(),
    })
    const store = useAnnouncementsStore()

    await store.fetch('token')

    expect(getAnnouncements).toHaveBeenCalledWith('token')
    expect(store.unreadCount).toBe(1)
    expect(store.bannerAnnouncement?.id).toBe('unread')
  })

  it('hides a closed banner without marking the announcement as read', async () => {
    vi.mocked(getAnnouncements).mockResolvedValue({
      data: [makeAnnouncement('first'), makeAnnouncement('second')],
      headers: new Headers(),
    })
    const store = useAnnouncementsStore()
    await store.fetch('token')

    store.hideBanner('first')

    expect(store.unreadCount).toBe(2)
    expect(store.bannerAnnouncement?.id).toBe('second')
    expect(dismissAnnouncement).not.toHaveBeenCalled()
  })

  it('persists read state and removes the announcement from badge and banner', async () => {
    vi.mocked(getAnnouncements).mockResolvedValue({
      data: [makeAnnouncement('first')],
      headers: new Headers(),
    })
    const store = useAnnouncementsStore()
    await store.fetch('token')

    await store.markRead('first', 'token')

    expect(dismissAnnouncement).toHaveBeenCalledWith('first', 'token')
    expect(store.unreadCount).toBe(0)
    expect(store.bannerAnnouncement).toBeNull()
    expect(store.items[0]?.read).toBe(true)
  })
})
