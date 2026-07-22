import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ShareView from '@/views/ShareView.vue'
import { useUiStore } from '@/stores/ui'
import { useComposeStore } from '@/stores/compose'
import { createStatus } from '@/api/mastodon/statuses'
import { createTestI18n } from '../helpers'

// The share intent must only ever prefill the composer — publishing stays
// behind the explicit submit button. Guard against any future code path
// publishing during share handling.
vi.mock('@/api/mastodon/statuses', () => ({
  createStatus: vi.fn(),
  editStatus: vi.fn(),
  getStatusSource: vi.fn(),
}))

const replace = vi.fn()
let route: { path: string; query: Record<string, unknown> }

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return {
    ...actual,
    useRoute: () => route,
    useRouter: () => ({ replace }),
  }
})

function mountShareView() {
  return mount(ShareView, {
    global: { plugins: [createTestI18n()] },
  })
}

describe('ShareView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    replace.mockClear()
    route = { path: '/share', query: {} }
  })

  it('opens the compose modal prefilled with the text param and settles on /home', () => {
    route.query = { text: '2026-07-21 헤아리\nhttps://heari.11ax.net\n\n#헤아리' }
    mountShareView()

    const ui = useUiStore()
    expect(ui.composeModalOpen).toBe(true)
    expect(ui.composePrefillText).toBe('2026-07-21 헤아리\nhttps://heari.11ax.net\n\n#헤아리')
    expect(replace).toHaveBeenCalledWith('/home')
  })

  it('joins title, text, and url params with blank lines', () => {
    route.query = { title: 'A title', text: 'Some text', url: 'https://example.com' }
    mountShareView()

    expect(useUiStore().composePrefillText).toBe('A title\n\nSome text\n\nhttps://example.com')
  })

  it('uses the first value of repeated params and skips empty ones', () => {
    route.query = { text: ['first', 'second'], url: '  ' }
    mountShareView()

    expect(useUiStore().composePrefillText).toBe('first')
  })

  it('opens an empty composer when no params are given', () => {
    mountShareView()

    const ui = useUiStore()
    expect(ui.composeModalOpen).toBe(true)
    expect(ui.composePrefillText).toBe('')
  })

  it('never publishes on its own — sharing only prefills the composer', async () => {
    route.query = { text: 'must not be auto-posted' }
    const wrapper = mountShareView()
    await wrapper.vm.$nextTick()

    expect(createStatus).not.toHaveBeenCalled()
    expect(useComposeStore().publishing).toBe(false)
  })

  it('stays in the classic design tree when visited via /old/share', () => {
    route = { path: '/old/share', query: { text: 'hello' } }
    mountShareView()

    expect(replace).toHaveBeenCalledWith('/old/home')
  })

  it('stays in the aurora design tree when visited via /aurora/share', () => {
    route = { path: '/aurora/share', query: { text: 'hello' } }
    mountShareView()

    expect(replace).toHaveBeenCalledWith('/aurora/home')
  })
})
