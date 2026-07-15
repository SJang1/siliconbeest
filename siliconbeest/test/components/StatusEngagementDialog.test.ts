import { createPinia, setActivePinia } from 'pinia'
import { defineComponent } from 'vue'
import type { PropType } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account } from '@/types/mastodon'
import { useAuthStore } from '@/stores/auth'
import StatusEngagementDialog from '@/components/status/StatusEngagementDialog.vue'
import { createTestI18n } from '../helpers'

const statusApiMocks = vi.hoisted(() => ({
  getFavouritedBy: vi.fn(),
  getRebloggedBy: vi.fn(),
}))

vi.mock('@/api/mastodon/statuses', () => ({
  getFavouritedBy: statusApiMocks.getFavouritedBy,
  getRebloggedBy: statusApiMocks.getRebloggedBy,
}))

const ModalStub = defineComponent({
  name: 'Modal',
  props: {
    open: Boolean,
    title: String,
  },
  emits: ['close'],
  template: '<section v-if="open" role="dialog"><h2>{{ title }}</h2><slot /></section>',
})

const AccountCardStub = defineComponent({
  name: 'AccountCard',
  props: {
    account: { type: Object as PropType<Account>, required: true },
  },
  template: '<div data-test="account-row">{{ account.id }}</div>',
})

function makeAccount(id: string): Account {
  return {
    id,
    username: id,
    acct: id,
    display_name: `Account ${id}`,
    locked: false,
    bot: false,
    discoverable: true,
    group: false,
    created_at: '2026-01-01T00:00:00.000Z',
    note: '',
    url: `https://example.test/@${id}`,
    uri: `https://example.test/users/${id}`,
    avatar: '',
    avatar_static: '',
    header: '',
    header_static: '',
    followers_count: 0,
    following_count: 0,
    statuses_count: 0,
    last_status_at: null,
    emojis: [],
    fields: [],
  }
}

function mountDialog(kind: 'favourites' | 'reblogs') {
  const pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuthStore()
  auth.token = 'viewer-token'

  return mount(StatusEngagementDialog, {
    props: {
      open: true,
      statusId: 'status-1',
      kind,
    },
    global: {
      plugins: [pinia, createTestI18n()],
      stubs: {
        Modal: ModalStub,
        LegacyModal: ModalStub,
        AccountCard: AccountCardStub,
        LegacyAccountCard: AccountCardStub,
        LoadingSpinner: true,
      },
    },
  })
}

describe('StatusEngagementDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('loads favourites with the login token and follows the Link max_id cursor', async () => {
    statusApiMocks.getFavouritedBy
      .mockResolvedValueOnce({
        data: [makeAccount('alice')],
        headers: new Headers({
          Link: '<https://example.test/api/v1/statuses/status-1/favourited_by?limit=20&max_id=favourite-row-cursor>; rel="next"',
        }),
      })
      .mockResolvedValueOnce({
        data: [makeAccount('bob')],
        headers: new Headers(),
      })

    const wrapper = mountDialog('favourites')
    await flushPromises()

    expect(statusApiMocks.getFavouritedBy).toHaveBeenNthCalledWith(
      1,
      'status-1',
      'viewer-token',
      { maxId: undefined, limit: 20 },
    )
    expect(statusApiMocks.getRebloggedBy).not.toHaveBeenCalled()
    expect(wrapper.findAll('[data-test="account-row"]')).toHaveLength(1)

    await wrapper.get('[data-test="engagement-load-more"]').trigger('click')
    await flushPromises()

    expect(statusApiMocks.getFavouritedBy).toHaveBeenNthCalledWith(
      2,
      'status-1',
      'viewer-token',
      { maxId: 'favourite-row-cursor', limit: 20 },
    )
    expect(wrapper.findAll('[data-test="account-row"]')).toHaveLength(2)
  })

  it('shows a recoverable server error and then an empty state', async () => {
    statusApiMocks.getRebloggedBy
      .mockRejectedValueOnce(new Error('Forbidden'))
      .mockResolvedValueOnce({ data: [], headers: new Headers() })

    const wrapper = mountDialog('reblogs')
    await flushPromises()

    expect(statusApiMocks.getRebloggedBy).toHaveBeenCalledWith(
      'status-1',
      'viewer-token',
      { maxId: undefined, limit: 20 },
    )
    expect(wrapper.get('[role="alert"]').text()).toContain('could not be loaded')

    await wrapper.get('[data-test="engagement-retry"]').trigger('click')
    await flushPromises()

    expect(statusApiMocks.getRebloggedBy).toHaveBeenCalledTimes(2)
    expect(wrapper.get('[data-test="engagement-empty"]').text()).toBe('No accounts to show.')
  })

  it('does not call the protected endpoints without a login token', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)

    const wrapper = mount(StatusEngagementDialog, {
      props: { open: true, statusId: 'status-1', kind: 'favourites' },
      global: {
        plugins: [pinia, createTestI18n()],
        stubs: {
          Modal: ModalStub,
          LegacyModal: ModalStub,
          AccountCard: AccountCardStub,
          LegacyAccountCard: AccountCardStub,
        },
      },
    })
    await flushPromises()

    expect(statusApiMocks.getFavouritedBy).not.toHaveBeenCalled()
    expect(statusApiMocks.getRebloggedBy).not.toHaveBeenCalled()
    expect(wrapper.get('[role="alert"]').text()).toContain('Log in')
  })
})
