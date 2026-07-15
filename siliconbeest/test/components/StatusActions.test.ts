import { describe, it, expect, vi } from 'vitest';
import StatusActions from '@/components/status/StatusActions.vue';
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
};

// Button order with menus closed:
// reply, boost/quote trigger, boost count, favourite/react trigger,
// favourite count, bookmark, share, more menu = 8 buttons
describe('StatusActions', () => {
  it('renders all action buttons', () => {
    const wrapper = mountWithPlugins(StatusActions, { props: baseProps });
    const buttons = wrapper.findAll('button');
    expect(buttons.length).toBe(8);
    expect(wrapper.get('[data-test="reply-action"]').classes()).toContain('min-h-11');
    expect(wrapper.get('[data-test="reblog-action"]').classes()).toContain('min-h-11');
    expect(wrapper.get('[data-test="favourite-action"]').classes()).toContain('min-h-11');
  });

  it('emits reply event on reply button click', async () => {
    const wrapper = mountWithPlugins(StatusActions, { props: baseProps });
    await wrapper.get('[data-test="reply-action"]').trigger('click');
    expect(wrapper.emitted('reply')).toBeTruthy();
    expect(wrapper.emitted('reply')![0]).toEqual(['123']);
  });

  it('emits reblog event via the boost menu', async () => {
    const wrapper = mountWithPlugins(StatusActions, { props: baseProps });
    // Open the boost/quote menu
    await wrapper.get('[data-test="reblog-action"]').trigger('click');
    const menuItems = wrapper.findAll('[role="menu"] button');
    expect(menuItems.length).toBe(2);
    await menuItems[0].trigger('click');
    expect(wrapper.emitted('reblog')).toBeTruthy();
    expect(wrapper.emitted('reblog')![0]).toEqual(['123']);
  });

  it('emits quote event via the boost menu', async () => {
    // Boolean props default to false when absent; the server sends
    // quote_policy_allows explicitly, so mirror that here.
    const wrapper = mountWithPlugins(StatusActions, {
      props: { ...baseProps, quotePolicyAllows: true },
    });
    await wrapper.get('[data-test="reblog-action"]').trigger('click');
    const menuItems = wrapper.findAll('[role="menu"] button');
    await menuItems[1].trigger('click');
    expect(wrapper.emitted('quote')).toBeTruthy();
    expect(wrapper.emitted('quote')![0]).toEqual(['123']);
  });

  it('emits favourite event via the favourite menu', async () => {
    const wrapper = mountWithPlugins(StatusActions, { props: baseProps });
    // Open the favourite/react menu
    await wrapper.get('[data-test="favourite-action"]').trigger('click');
    const menuItems = wrapper.findAll('[role="menu"] button');
    expect(menuItems.length).toBe(2);
    await menuItems[0].trigger('click');
    expect(wrapper.emitted('favourite')).toBeTruthy();
    expect(wrapper.emitted('favourite')![0]).toEqual(['123']);
  });

  it('emits react event via the favourite menu', async () => {
    const wrapper = mountWithPlugins(StatusActions, { props: baseProps });
    await wrapper.get('[data-test="favourite-action"]').trigger('click');
    const menuItems = wrapper.findAll('[role="menu"] button');
    await menuItems[1].trigger('click');
    expect(wrapper.emitted('react')).toBeTruthy();
    // Payload: status id + the favourite button as picker anchor
    expect(wrapper.emitted('react')![0]![0]).toBe('123');
  });

  it('emits bookmark event on bookmark button click', async () => {
    const wrapper = mountWithPlugins(StatusActions, { props: baseProps });
    await wrapper.get('[data-test="bookmark-action"]').trigger('click');
    expect(wrapper.emitted('bookmark')).toBeTruthy();
    expect(wrapper.emitted('bookmark')![0]).toEqual(['123']);
  });

  it('emits share event on share button click', async () => {
    const wrapper = mountWithPlugins(StatusActions, { props: baseProps });
    await wrapper.get('[data-test="share-action"]').trigger('click');
    expect(wrapper.emitted('share')).toBeTruthy();
    expect(wrapper.emitted('share')![0]).toEqual(['123']);
  });

  it('shows active state when favourited', () => {
    const wrapper = mountWithPlugins(StatusActions, {
      props: { ...baseProps, favourited: true },
    });
    const favButton = wrapper.get('[data-test="favourite-action"]');
    expect(favButton.attributes('aria-pressed')).toBe('true');
    expect(favButton.html()).toContain('text-rose-500');
  });

  it('shows active state when reblogged', () => {
    const wrapper = mountWithPlugins(StatusActions, {
      props: { ...baseProps, reblogged: true },
    });
    const reblogButton = wrapper.get('[data-test="reblog-action"]');
    expect(reblogButton.attributes('aria-pressed')).toBe('true');
    expect(reblogButton.html()).toContain('text-green-600');
  });

  it('shows active state when bookmarked', () => {
    const wrapper = mountWithPlugins(StatusActions, {
      props: { ...baseProps, bookmarked: true },
    });
    const bookmarkButton = wrapper.get('[data-test="bookmark-action"]');
    expect(bookmarkButton.attributes('aria-pressed')).toBe('true');
    expect(bookmarkButton.html()).toContain('text-amber-500');
  });

  it('displays formatted counts', () => {
    const wrapper = mountWithPlugins(StatusActions, { props: baseProps });
    const text = wrapper.text();
    expect(text).toContain('5');   // replies
    expect(text).toContain('10');  // reblogs
    expect(text).toContain('42');  // favourites
  });

  it('formats large counts with K suffix', () => {
    const wrapper = mountWithPlugins(StatusActions, {
      props: { ...baseProps, favouritesCount: 1500 },
    });
    expect(wrapper.text()).toContain('1.5K');
  });

  it('does not display count when zero', () => {
    const wrapper = mountWithPlugins(StatusActions, {
      props: { ...baseProps, repliesCount: 0, reblogsCount: 0, favouritesCount: 0 },
    });
    // All counts are 0, so formatCount returns '' for them
    const spans = wrapper.findAll('span.tabular-nums');
    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) {
      expect(span.text()).toBe('');
    }
    expect(wrapper.find('[data-test="reblogs-count"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="favourites-count"]').exists()).toBe(false);
  });

  it('opens engagement lists from separate count buttons without toggling actions', async () => {
    const wrapper = mountWithPlugins(StatusActions, { props: baseProps });

    await wrapper.get('[data-test="reblogs-count"]').trigger('click');
    await wrapper.get('[data-test="favourites-count"]').trigger('click');

    expect(wrapper.emitted('viewReblogs')?.[0]).toEqual(['123']);
    expect(wrapper.emitted('viewFavourites')?.[0]).toEqual(['123']);
    expect(wrapper.emitted('reblog')).toBeFalsy();
    expect(wrapper.emitted('favourite')).toBeFalsy();
    expect(wrapper.find('[role="menu"]').exists()).toBe(false);
  });

  it('stops engagement count clicks from bubbling to a status card', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const cardClick = vi.fn();
    host.addEventListener('click', cardClick);
    const wrapper = mountWithPlugins(StatusActions, { props: baseProps, attachTo: host });

    await wrapper.get('[data-test="reblogs-count"]').trigger('click');

    expect(cardClick).not.toHaveBeenCalled();
    wrapper.unmount();
    host.remove();
  });

  it('disables account actions for logged-out viewers and does not emit them', async () => {
    const wrapper = mountWithPlugins(StatusActions, {
      props: { ...baseProps, accountCanAct: false, viewerAuthenticated: false, quotePolicyAllows: true },
    });

    const buttons = wrapper.findAll('button');
    expect(buttons).toHaveLength(5);
    expect(buttons[0]!.attributes('disabled')).toBeDefined();
    expect(buttons[1]!.attributes('disabled')).toBeDefined();
    expect(buttons[2]!.attributes('disabled')).toBeDefined();
    expect(buttons[3]!.attributes('disabled')).toBeDefined();
    expect(wrapper.find('[data-test="reblogs-count"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="favourites-count"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('10');
    expect(wrapper.text()).toContain('42');

    await wrapper.get('[data-test="reply-action"]').trigger('click');
    await wrapper.get('[data-test="reblog-action"]').trigger('click');
    await wrapper.get('[data-test="favourite-action"]').trigger('click');
    await wrapper.get('[data-test="bookmark-action"]').trigger('click');
    expect(wrapper.emitted('reply')).toBeFalsy();
    expect(wrapper.emitted('reblog')).toBeFalsy();
    expect(wrapper.emitted('favourite')).toBeFalsy();
    expect(wrapper.emitted('bookmark')).toBeFalsy();
  });

  it('allows an owner to quote a private status when the API permits it', async () => {
    const wrapper = mountWithPlugins(StatusActions, {
      props: {
        ...baseProps,
        isOwnStatus: true,
        visibility: 'private',
        quotePolicyAllows: true,
      },
    });

    await wrapper.get('[data-test="reblog-action"]').trigger('click');
    const menuItems = wrapper.findAll('[role="menu"] button');
    expect(menuItems[0]!.attributes('disabled')).toBeDefined();
    expect(menuItems[1]!.attributes('disabled')).toBeUndefined();
    await menuItems[1]!.trigger('click');
    expect(wrapper.emitted('quote')![0]).toEqual(['123']);
  });

  it('fails closed when the API omits the per-viewer quote permission', async () => {
    const wrapper = mountWithPlugins(StatusActions, { props: baseProps });
    await wrapper.get('[data-test="reblog-action"]').trigger('click');
    const menuItems = wrapper.findAll('[role="menu"] button');
    expect(menuItems[1]!.attributes('disabled')).toBeDefined();
  });
});
