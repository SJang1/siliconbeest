import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SettingsInvitationsView from '@/views/SettingsInvitationsView.vue'
import { useAuthStore } from '@/stores/auth'
import { createTestI18n } from '../helpers'

const invitationApi = vi.hoisted(() => ({
  createInvitation: vi.fn(),
  getInvitationCredits: vi.fn(),
  listInvitations: vi.fn(),
  revokeInvitation: vi.fn(),
}))

vi.mock('@/api/mastodon/invitations', () => invitationApi)

describe('SettingsInvitationsView', () => {
  let pinia: ReturnType<typeof createPinia>

  beforeEach(() => {
    vi.clearAllMocks()
    pinia = createPinia()
    setActivePinia(pinia)
    useAuthStore().setToken('invitation-test-token')

    invitationApi.listInvitations.mockResolvedValue({
      data: [
        {
          id: 'invite-1',
          url: 'https://example.test/?invite=first',
          uses_remaining: 1,
          issued_uses: 1,
          expires_at: null,
          auto_follow: true,
          revoked_at: null,
          created_at: '2026-07-16T00:00:00.000Z',
        },
        {
          id: 'invite-2',
          url: 'https://example.test/?invite=second',
          uses_remaining: 2,
          issued_uses: 2,
          expires_at: null,
          auto_follow: false,
          revoked_at: null,
          created_at: '2026-07-16T01:00:00.000Z',
        },
      ],
    })
    invitationApi.getInvitationCredits.mockResolvedValue({
      data: {
        available_credits: 1,
        reserved_credits: 3,
        pending_refund_credits: 0,
        owned_credits: 4,
        max_credits: 999,
        contribution_score: 0,
        contribution_threshold: 100,
        contribution_enabled: false,
        issuance_enabled: true,
        can_issue_links: true,
      },
    })
  })

  it('keeps every active invitation URL visible and independently copyable', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const wrapper = mount(SettingsInvitationsView, {
      global: { plugins: [pinia, createTestI18n()] },
    })
    await flushPromises()

    const linkInputs = wrapper.findAll('input[readonly]')
    expect(linkInputs.map((input) => input.element.value)).toEqual([
      'https://example.test/?invite=first',
      'https://example.test/?invite=second',
    ])

    const copyButtons = wrapper.findAll('button').filter((button) => button.text() === 'Copy link')
    await copyButtons[1]?.trigger('click')
    expect(writeText).toHaveBeenCalledWith('https://example.test/?invite=second')
  })
})
