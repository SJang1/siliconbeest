import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import DeckMobileNav from '@/deck/layout/DeckMobileNav.vue'
import { useAuthStore } from '@/stores/auth'
import { useAnnouncementsStore } from '@/stores/announcements'
import { createTestI18n } from '../helpers'

describe('DeckMobileNav', () => {
  let pinia: ReturnType<typeof createPinia>

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    localStorage.clear()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  async function mountNav() {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/home', name: 'home', component: { template: '<div />' } },
        { path: '/:pathMatch(.*)*', component: { template: '<div />' } },
      ],
    })
    await router.push('/home')
    await router.isReady()
    return mount(DeckMobileNav, {
      attachTo: document.body,
      global: { plugins: [pinia, createTestI18n(), router] },
    })
  }

  it('moves announcements, search, and settings from the bottom bar into More', async () => {
    useAuthStore().setToken('mobile-nav-token')
    const wrapper = await mountNav()

    expect(wrapper.find('a[href="/announcements"]').exists()).toBe(false)
    expect(wrapper.find('a[href="/search"]').exists()).toBe(false)
    expect(wrapper.find('a[href="/settings"]').exists()).toBe(false)

    await wrapper.get('button[aria-label="More"]').trigger('click')

    const menu = document.body.querySelector('[role="menu"][aria-label="More"]')
    expect(menu).not.toBeNull()
    expect(menu?.querySelector('[data-mobile-menu-path="/announcements"]')).not.toBeNull()
    expect(menu?.querySelector('[data-mobile-menu-path="/search"]')).not.toBeNull()
    expect(menu?.querySelector('[data-mobile-menu-path="/settings"]')).not.toBeNull()
  })

  it('includes every desktop rail destination in the mobile More menu', async () => {
    useAuthStore().setToken('mobile-nav-token')
    const wrapper = await mountNav()
    await wrapper.get('button[aria-label="More"]').trigger('click')

    const paths = Array.from(document.body.querySelectorAll('[data-mobile-menu-path]'))
      .map((element) => element.getAttribute('data-mobile-menu-path'))

    expect(paths).toEqual(expect.arrayContaining([
      '/home',
      '/timelines/home',
      '/timelines/local',
      '/timelines/social',
      '/timelines/federated',
      '/announcements',
      '/notifications',
      '/search',
      '/invitations',
      '/bookmarks',
      '/favourites',
      '/lists',
      '/followed_tags',
      '/directory',
      '/follow-requests',
      '/about',
      '/settings',
      '/settings/profile',
      '/aurora/home',
      '/old/',
    ]))
  })

  it('does not show an announcement badge to signed-out users', async () => {
    useAuthStore().clearToken()
    useAnnouncementsStore().items = [{
      id: 'public-announcement',
      content: 'Public announcement',
      starts_at: null,
      ends_at: null,
      all_day: false,
      published_at: '2026-07-18T00:00:00.000Z',
      updated_at: '2026-07-18T00:00:00.000Z',
      read: false,
      mentions: [],
      statuses: [],
      tags: [],
      emojis: [],
      reactions: [],
    }]
    const wrapper = await mountNav()

    expect(wrapper.get('button[aria-label="More"]').find('.dk-rail-badge').exists()).toBe(false)
  })
})
