import { describe, expect, it } from 'vitest'
import LegacyStatusActions from '@/legacy/components/status/StatusActions.vue'
import { mountWithPlugins } from '../helpers'

const baseProps = {
  statusId: 'legacy-status',
  repliesCount: 3,
  reblogsCount: 7,
  favouritesCount: 11,
  favourited: false,
  reblogged: false,
  bookmarked: false,
  accountCanAct: true,
  viewerAuthenticated: true,
  visibility: 'public',
  quotePolicyAllows: true,
}

describe('LegacyStatusActions engagement counts', () => {
  it('keeps the engagement counts separate from the action buttons', async () => {
    const wrapper = mountWithPlugins(LegacyStatusActions, { props: baseProps })

    await wrapper.get('[data-test="reblogs-count"]').trigger('click')
    await wrapper.get('[data-test="favourites-count"]').trigger('click')

    expect(wrapper.emitted('viewReblogs')?.[0]).toEqual(['legacy-status'])
    expect(wrapper.emitted('viewFavourites')?.[0]).toEqual(['legacy-status'])
    expect(wrapper.emitted('reblog')).toBeFalsy()
    expect(wrapper.emitted('favourite')).toBeFalsy()
  })

  it('retains readable counts without list controls for logged-out viewers', () => {
    const wrapper = mountWithPlugins(LegacyStatusActions, {
      props: { ...baseProps, accountCanAct: false, viewerAuthenticated: false },
    })

    expect(wrapper.find('[data-test="reblogs-count"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="favourites-count"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('7')
    expect(wrapper.text()).toContain('11')
  })

  it('does not render list controls for zero counts and uses larger action targets', () => {
    const wrapper = mountWithPlugins(LegacyStatusActions, {
      props: { ...baseProps, reblogsCount: 0, favouritesCount: 0 },
    })

    expect(wrapper.find('[data-test="reblogs-count"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="favourites-count"]').exists()).toBe(false)
    expect(wrapper.get('[data-test="reply-action"]').classes()).toContain('min-h-11')
    expect(wrapper.get('[data-test="reblog-action"]').classes()).toContain('min-h-11')
    expect(wrapper.get('[data-test="favourite-action"]').classes()).toContain('min-h-11')
  })
})
