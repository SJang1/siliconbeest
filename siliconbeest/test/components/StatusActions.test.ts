import { describe, it, expect } from 'vitest';
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
};

// Button order with menus closed:
// 0 reply, 1 boost/quote menu trigger, 2 favourite/react menu trigger,
// 3 bookmark, 4 share, 5 more menu = 6 buttons
describe('StatusActions', () => {
  it('renders all action buttons', () => {
    const wrapper = mountWithPlugins(StatusActions, { props: baseProps });
    const buttons = wrapper.findAll('button');
    expect(buttons.length).toBe(6);
  });

  it('emits reply event on reply button click', async () => {
    const wrapper = mountWithPlugins(StatusActions, { props: baseProps });
    const buttons = wrapper.findAll('button');
    await buttons[0].trigger('click');
    expect(wrapper.emitted('reply')).toBeTruthy();
    expect(wrapper.emitted('reply')![0]).toEqual(['123']);
  });

  it('emits reblog event via the boost menu', async () => {
    const wrapper = mountWithPlugins(StatusActions, { props: baseProps });
    // Open the boost/quote menu
    await wrapper.findAll('button')[1].trigger('click');
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
    await wrapper.findAll('button')[1].trigger('click');
    const menuItems = wrapper.findAll('[role="menu"] button');
    await menuItems[1].trigger('click');
    expect(wrapper.emitted('quote')).toBeTruthy();
    expect(wrapper.emitted('quote')![0]).toEqual(['123']);
  });

  it('emits favourite event via the favourite menu', async () => {
    const wrapper = mountWithPlugins(StatusActions, { props: baseProps });
    // Open the favourite/react menu
    await wrapper.findAll('button')[2].trigger('click');
    const menuItems = wrapper.findAll('[role="menu"] button');
    expect(menuItems.length).toBe(2);
    await menuItems[0].trigger('click');
    expect(wrapper.emitted('favourite')).toBeTruthy();
    expect(wrapper.emitted('favourite')![0]).toEqual(['123']);
  });

  it('emits react event via the favourite menu', async () => {
    const wrapper = mountWithPlugins(StatusActions, { props: baseProps });
    await wrapper.findAll('button')[2].trigger('click');
    const menuItems = wrapper.findAll('[role="menu"] button');
    await menuItems[1].trigger('click');
    expect(wrapper.emitted('react')).toBeTruthy();
    expect(wrapper.emitted('react')![0]).toEqual(['123']);
  });

  it('emits bookmark event on bookmark button click', async () => {
    const wrapper = mountWithPlugins(StatusActions, { props: baseProps });
    const buttons = wrapper.findAll('button');
    await buttons[3].trigger('click');
    expect(wrapper.emitted('bookmark')).toBeTruthy();
    expect(wrapper.emitted('bookmark')![0]).toEqual(['123']);
  });

  it('emits share event on share button click', async () => {
    const wrapper = mountWithPlugins(StatusActions, { props: baseProps });
    const buttons = wrapper.findAll('button');
    await buttons[4].trigger('click');
    expect(wrapper.emitted('share')).toBeTruthy();
    expect(wrapper.emitted('share')![0]).toEqual(['123']);
  });

  it('shows active state when favourited', () => {
    const wrapper = mountWithPlugins(StatusActions, {
      props: { ...baseProps, favourited: true },
    });
    const favButton = wrapper.findAll('button')[2];
    expect(favButton.attributes('aria-pressed')).toBe('true');
    expect(favButton.html()).toContain('text-rose-500');
  });

  it('shows active state when reblogged', () => {
    const wrapper = mountWithPlugins(StatusActions, {
      props: { ...baseProps, reblogged: true },
    });
    const reblogButton = wrapper.findAll('button')[1];
    expect(reblogButton.attributes('aria-pressed')).toBe('true');
    expect(reblogButton.html()).toContain('text-green-600');
  });

  it('shows active state when bookmarked', () => {
    const wrapper = mountWithPlugins(StatusActions, {
      props: { ...baseProps, bookmarked: true },
    });
    const bookmarkButton = wrapper.findAll('button')[3];
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
  });
});
