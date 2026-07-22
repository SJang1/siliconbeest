import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import StatusComposer from '@/components/status/StatusComposer.vue'
import LegacyStatusComposer from '@/legacy/components/status/StatusComposer.vue'
import { createTestI18n } from '../helpers'

vi.mock('@/composables/useEmojis', () => ({
  useEmojis: () => ({
    fetchCustomEmojis: vi.fn(),
    searchEmojis: vi.fn(() => []),
  }),
}))

vi.mock('@/api/mastodon/search', () => ({
  search: vi.fn(),
}))

const NOTE_TEXTAREA = 'textarea[placeholder="What\'s on your mind?"]'

describe.each([
  ['StatusComposer', StatusComposer],
  ['LegacyStatusComposer', LegacyStatusComposer],
])('%s prefill', (_name, component) => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('seeds the note content from the initialText prop', () => {
    const wrapper = mount(component, {
      props: { initialText: 'shared text\n\n#tag' },
      global: { plugins: [createTestI18n()] },
    })

    expect(wrapper.get<HTMLTextAreaElement>(NOTE_TEXTAREA).element.value).toBe('shared text\n\n#tag')
  })

  it('starts empty without the prop', () => {
    const wrapper = mount(component, {
      global: { plugins: [createTestI18n()] },
    })

    expect(wrapper.get<HTMLTextAreaElement>(NOTE_TEXTAREA).element.value).toBe('')
  })

  it('never auto-submits prefilled content on mount', async () => {
    const wrapper = mount(component, {
      props: { initialText: 'shared text' },
      global: { plugins: [createTestI18n()] },
    })
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('submit')).toBeUndefined()
  })

  it('publishes only when the user explicitly submits', async () => {
    const wrapper = mount(component, {
      props: { initialText: 'shared text' },
      global: { plugins: [createTestI18n()] },
    })

    expect(wrapper.get<HTMLButtonElement>('button[type="submit"]').element.disabled).toBe(false)
    await wrapper.get('form').trigger('submit.prevent')

    const emitted = wrapper.emitted<[{ content: string }]>('submit')
    expect(emitted).toHaveLength(1)
    expect(emitted![0]![0]!.content).toBe('shared text')
  })
})
