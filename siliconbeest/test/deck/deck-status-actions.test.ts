import { describe, it, expect } from 'vitest';
import DeckStatusActions from '@/deck/components/DeckStatusActions.vue';
import { mountWithPlugins } from '../helpers';

const baseProps = {
  statusId: '123',
  repliesCount: 5,
  reblogsCount: 10,
  favouritesCount: 42,
  favourited: false,
  reblogged: false,
  bookmarked: false,
  accountCanAct: true,
  viewerAuthenticated: true,
  visibility: 'public',
  quotePolicyAllows: true,
};

function buttonByText(wrapper: ReturnType<typeof mountWithPlugins>, text: string) {
  return wrapper.findAll('button').find((b) => b.text().includes(text));
}

describe('DeckStatusActions', () => {
  it('renders a compact row with separate engagement count buttons', () => {
    const wrapper = mountWithPlugins(DeckStatusActions, { props: baseProps });
    expect(wrapper.findAll('button').length).toBe(6);
    expect(wrapper.get('[data-test="reply-action"]').classes()).toContain('min-h-11');
    expect(wrapper.get('[data-test="reblog-action"]').classes()).toContain('min-h-11');
    expect(wrapper.get('[data-test="favourite-action"]').classes()).toContain('min-h-11');
    expect(wrapper.get('[data-test="reblogs-count"]').attributes('aria-haspopup')).toBe('dialog');
    expect(wrapper.get('[data-test="favourites-count"]').attributes('aria-haspopup')).toBe('dialog');
  });

  it('emits reply directly', async () => {
    const wrapper = mountWithPlugins(DeckStatusActions, { props: baseProps });
    await wrapper.get('[data-test="reply-action"]').trigger('click');
    expect(wrapper.emitted('reply')![0]).toEqual(['123']);
  });

  it('boost chooser asks repost or quote', async () => {
    const wrapper = mountWithPlugins(DeckStatusActions, { props: baseProps });
    await wrapper.get('[data-test="reblog-action"]').trigger('click');
    expect(wrapper.emitted('overlay')![0]).toEqual([true]);

    await buttonByText(wrapper, 'Boost')!.trigger('click');
    expect(wrapper.emitted('reblog')![0]).toEqual(['123']);

    // Menu closed after picking
    expect(buttonByText(wrapper, 'Quote')).toBeUndefined();
  });

  it('boost chooser can quote instead', async () => {
    const wrapper = mountWithPlugins(DeckStatusActions, { props: baseProps });
    await wrapper.get('[data-test="reblog-action"]').trigger('click');
    await buttonByText(wrapper, 'Quote')!.trigger('click');
    expect(wrapper.emitted('quote')![0]).toEqual(['123']);
    expect(wrapper.emitted('reblog')).toBeFalsy();
  });

  it('star chooser asks favourite or emoji reaction', async () => {
    const wrapper = mountWithPlugins(DeckStatusActions, { props: baseProps });
    await wrapper.get('[data-test="favourite-action"]').trigger('click');

    await buttonByText(wrapper, 'Favourite')!.trigger('click');
    expect(wrapper.emitted('favourite')![0]).toEqual(['123']);

    await wrapper.get('[data-test="favourite-action"]').trigger('click');
    await buttonByText(wrapper, 'React with emoji')!.trigger('click');
    // Payload: status id + the star button as emoji-picker anchor
    expect(wrapper.emitted('react')![0]![0]).toBe('123');
  });

  it('bookmark and share live in the more menu with text labels', async () => {
    const wrapper = mountWithPlugins(DeckStatusActions, { props: baseProps });
    await wrapper.get('[data-test="more-action"]').trigger('click');
    await buttonByText(wrapper, 'Bookmark')!.trigger('click');
    expect(wrapper.emitted('bookmark')![0]).toEqual(['123']);

    await wrapper.get('[data-test="more-action"]').trigger('click');
    await buttonByText(wrapper, 'Share')!.trigger('click');
    expect(wrapper.emitted('share')![0]).toEqual(['123']);
  });

  it('disables repost for private posts but keeps the chooser usable', async () => {
    const wrapper = mountWithPlugins(DeckStatusActions, {
      props: { ...baseProps, visibility: 'private' },
    });
    await wrapper.get('[data-test="reblog-action"]').trigger('click');
    const repost = buttonByText(wrapper, 'Boost')!;
    expect(repost.attributes('disabled')).toBeDefined();
    await repost.trigger('click');
    expect(wrapper.emitted('reblog')).toBeFalsy();
  });

  it('keeps private-owner quote available when the API permits it', async () => {
    const wrapper = mountWithPlugins(DeckStatusActions, {
      props: { ...baseProps, isOwnStatus: true, visibility: 'private' },
    });
    await wrapper.get('[data-test="reblog-action"]').trigger('click');
    expect(buttonByText(wrapper, 'Boost')!.attributes('disabled')).toBeDefined();
    expect(buttonByText(wrapper, 'Quote')!.attributes('disabled')).toBeUndefined();
  });

  it('does not offer authenticated actions to a logged-out viewer', () => {
    const wrapper = mountWithPlugins(DeckStatusActions, {
      props: { ...baseProps, accountCanAct: false, viewerAuthenticated: false },
    });
    const buttons = wrapper.findAll('button');
    expect(buttons).toHaveLength(4);
    expect(buttons[0]!.attributes('disabled')).toBeDefined();
    expect(buttons[1]!.attributes('disabled')).toBeDefined();
    expect(buttons[2]!.attributes('disabled')).toBeDefined();
    // The final menu remains because sharing a public post is anonymous-safe.
    expect(buttons[3]!.attributes('disabled')).toBeUndefined();
  });

  it('opens engagement lists from the counts without opening chooser menus', async () => {
    const wrapper = mountWithPlugins(DeckStatusActions, { props: baseProps });

    await wrapper.get('[data-test="reblogs-count"]').trigger('click');
    await wrapper.get('[data-test="favourites-count"]').trigger('click');

    expect(wrapper.emitted('viewReblogs')?.[0]).toEqual(['123']);
    expect(wrapper.emitted('viewFavourites')?.[0]).toEqual(['123']);
    expect(wrapper.emitted('reblog')).toBeFalsy();
    expect(wrapper.emitted('favourite')).toBeFalsy();
    expect(wrapper.find('.dk-menu').exists()).toBe(false);
  });

  it('does not render engagement count buttons for zero counts or logged-out viewers', () => {
    const zero = mountWithPlugins(DeckStatusActions, {
      props: { ...baseProps, reblogsCount: 0, favouritesCount: 0 },
    });
    expect(zero.find('[data-test="reblogs-count"]').exists()).toBe(false);
    expect(zero.find('[data-test="favourites-count"]').exists()).toBe(false);

    const loggedOut = mountWithPlugins(DeckStatusActions, {
      props: { ...baseProps, accountCanAct: false, viewerAuthenticated: false },
    });
    expect(loggedOut.find('[data-test="reblogs-count"]').exists()).toBe(false);
    expect(loggedOut.find('[data-test="favourites-count"]').exists()).toBe(false);
    expect(loggedOut.text()).toContain('10');
    expect(loggedOut.text()).toContain('42');
  });
});
