import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Component } from 'vue'
import type { Instance } from '@/types/mastodon'
import HomeColumn from '@/components/timeline/HomeColumn.vue'
import LegacyHomeColumn from '@/legacy/components/timeline/HomeColumn.vue'
import DeckColumn from '@/deck/components/DeckColumn.vue'
import RecommendedColumn from '@/components/timeline/RecommendedColumn.vue'
import LegacyRecommendedColumn from '@/legacy/components/timeline/RecommendedColumn.vue'
import DeckRecommendedColumn from '@/deck/components/DeckRecommendedColumn.vue'
import { useAuthStore } from '@/stores/auth'
import { useInstanceStore } from '@/stores/instance'
import { useTimelinesStore } from '@/stores/timelines'
import { createTestI18n } from '../helpers'

const recommendedVariants: Array<{
  name: string
  component: Component
  props?: Record<string, unknown>
}> = [
  { name: 'Aurora', component: RecommendedColumn },
  { name: 'Classic', component: LegacyRecommendedColumn },
  { name: 'Deck', component: DeckRecommendedColumn, props: { fluid: true } },
]

const homeVariants: Array<{
  name: string
  component: Component
  props?: Record<string, unknown>
}> = [
  { name: 'Aurora', component: HomeColumn },
  { name: 'Classic', component: LegacyHomeColumn },
  { name: 'Deck', component: DeckColumn, props: { type: 'home' } },
]

function instance(recommendedTimeline: boolean): Instance {
  return {
    configuration: {
      translation: { enabled: true },
      ai: {
        enabled: recommendedTimeline,
        recommended_timeline: recommendedTimeline,
        image_description: recommendedTimeline,
      },
    },
  } as Instance
}

async function mountComponent(component: Component, props?: Record<string, unknown>) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
  })
  await router.push('/')
  await router.isReady()

  const wrapper = mount(component, {
    props,
    global: {
      plugins: [createTestI18n(), router],
      stubs: {
        TimelineFeed: true,
        ThreadView: true,
        AnnouncementBanner: true,
        InfiniteScroll: { template: '<div><slot /></div>' },
        DeckStatusCard: true,
      },
    },
  })
  await flushPromises()
  return wrapper
}

describe.each(recommendedVariants)('$name dedicated recommended timeline', ({ component, props }) => {
  beforeEach(() => {
    const pinia = createPinia()
    setActivePinia(pinia)
    localStorage.clear()
    document.cookie = 'siliconbeest_token=; Path=/; Max-Age=0'
    vi.clearAllMocks()
  })

  it('loads only the recommended state and labels generation failures', async () => {
    useAuthStore().setToken('recommendation-token')
    useInstanceStore().instance = instance(true)
    const timelines = useTimelinesStore()
    timelines.getTimeline('home').statusIds = ['home-state-must-stay-separate']
    const refresh = vi.spyOn(timelines, 'refreshRecommendedTimeline')
      .mockImplementation(async () => {
        timelines.getTimeline('recommended').error
          = 'HTTP 429\ncode: 3040\nCapacity temporarily exceeded, please try again.'
      })
    const fetchTimeline = vi.spyOn(timelines, 'fetchTimeline').mockResolvedValue()

    const wrapper = await mountComponent(component, props)

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledWith('recommendation-token')
    expect(fetchTimeline).not.toHaveBeenCalledWith('home', expect.anything())
    expect(timelines.getTimeline('home').statusIds).toEqual(['home-state-must-stay-separate'])
    expect(wrapper.text()).toContain('AI recommendations')
    expect(wrapper.text()).toContain('AI-generated recommended feed')
    expect(wrapper.text()).toContain('AI recommendations could not be generated.')
    expect(wrapper.text()).toContain(
      'Reason: HTTP 429\ncode: 3040\nCapacity temporarily exceeded, please try again.',
    )
    expect(wrapper.find('[role="alert"]').text()).toContain('Refresh recommendations')
  })

  it('does not invoke AI when the recommendation capability is disabled', async () => {
    useAuthStore().setToken('recommendation-token')
    useInstanceStore().instance = instance(false)
    const refresh = vi.spyOn(useTimelinesStore(), 'refreshRecommendedTimeline').mockResolvedValue()

    await mountComponent(component, props)

    expect(refresh).not.toHaveBeenCalled()
  })
})

describe.each(homeVariants)('$name home timeline remains independent', ({ component, props }) => {
  beforeEach(() => {
    const pinia = createPinia()
    setActivePinia(pinia)
    localStorage.clear()
    document.cookie = 'siliconbeest_token=; Path=/; Max-Age=0'
    vi.clearAllMocks()
  })

  it('loads home without exposing or generating recommendations', async () => {
    useAuthStore().setToken('home-token')
    useInstanceStore().instance = instance(true)
    const timelines = useTimelinesStore()
    const fetchTimeline = vi.spyOn(timelines, 'fetchTimeline').mockResolvedValue()
    const refresh = vi.spyOn(timelines, 'refreshRecommendedTimeline').mockResolvedValue()

    const wrapper = await mountComponent(component, props)

    expect(fetchTimeline).toHaveBeenCalledWith('home', expect.objectContaining({ token: 'home-token' }))
    expect(refresh).not.toHaveBeenCalled()
    expect(wrapper.text()).not.toContain('Recommended')
    expect(wrapper.text()).not.toContain('AI-generated recommended feed')
  })
})
