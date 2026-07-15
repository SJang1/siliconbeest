import { describe, expect, it, vi } from 'vitest'
import { mount, RouterLinkStub } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import AnnouncementBanner from '@/components/common/AnnouncementBanner.vue'
import DeckAnnouncementsView from '@/deck/views/DeckAnnouncementsView.vue'
import { useAnnouncementsStore } from '@/stores/announcements'
import type { Announcement } from '@/types/mastodon'

vi.mock('@/api/mastodon/instance', () => ({
  getAnnouncements: vi.fn().mockResolvedValue({ data: [], headers: new Headers() }),
  dismissAnnouncement: vi.fn().mockResolvedValue({ data: {}, headers: new Headers() }),
}))

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({ token: 'token' }),
}))

const t = (key: string, params?: Record<string, unknown>) => params?.count ? `${params.count} ${key}` : key

function i18nPlugin() {
  return createI18n({
    legacy: false,
    locale: 'en',
    messages: { en: {} },
    missing: (_locale, key) => key,
  })
}

function maliciousAnnouncement(): Announcement {
  return {
    id: 'xss',
    content: '<img src="x" onerror="globalThis.__siliconbeest_xss=document.cookie"><b>XSS</b>',
    starts_at: null,
    ends_at: null,
    all_day: false,
    published_at: '2026-07-16T00:00:00.000Z',
    updated_at: '2026-07-16T00:00:00.000Z',
    read: false,
    mentions: [],
    statuses: [],
    tags: [],
    emojis: [],
    reactions: [],
  }
}

function seedAnnouncements() {
  setActivePinia(createPinia())
  const store = useAnnouncementsStore()
  store.items = [maliciousAnnouncement()]
  return store
}

describe('announcement rendering', () => {
  it('renders the banner announcement as escaped text', () => {
    seedAnnouncements()

    const wrapper = mount(AnnouncementBanner, {
      global: {
        stubs: { RouterLink: RouterLinkStub },
        mocks: { $t: t },
        plugins: [i18nPlugin()],
      },
    })

    expect(wrapper.text()).toContain('<img src="x" onerror=')
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('b').exists()).toBe(false)
    expect(wrapper.html()).toContain('&lt;img')
  })

  it('renders the announcement center content as escaped text', () => {
    seedAnnouncements()

    const wrapper = mount(DeckAnnouncementsView, {
      global: {
        stubs: {
          DeckPageShell: { template: '<section><slot /></section>' },
        },
        mocks: { $t: t },
        plugins: [i18nPlugin()],
      },
    })

    expect(wrapper.text()).toContain('<img src="x" onerror=')
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('b').exists()).toBe(false)
    expect(wrapper.html()).toContain('&lt;img')
  })
})
