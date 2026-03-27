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

describe('StatusActions', () => {
  it('renders all action buttons', () => {
    const wrapper = mountWithPlugins(StatusActions, { props: baseProps });
    const buttons = wrapper.findAll('button');
    // reply, reblog, favourite, bookmark, share, more menu = 6 buttons
    expect(buttons.length).toBe(6);
  });

  it('emits favourite event on favourite button click', async () => {
    const wrapper = mountWithPlugins(StatusActions, { props: baseProps });
    const buttons = wrapper.findAll('button');
    // favourite is the 3rd button (index 2)
    await buttons[2].trigger('click');
    expect(wrapper.emitted('favourite')).toBeTruthy();
    expect(wrapper.emitted('favourite')![0]).toEqual(['123']);
  });

  it('emits reply event on reply button click', async () => {
    const wrapper = mountWithPlugins(StatusActions, { props: baseProps });
    const buttons = wrapper.findAll('button');
    await buttons[0].trigger('click');
    expect(wrapper.emitted('reply')).toBeTruthy();
    expect(wrapper.emitted('reply')![0]).toEqual(['123']);
  });

  it('emits reblog event on reblog button click', async () => {
    const wrapper = mountWithPlugins(StatusActions, { props: baseProps });
    const buttons = wrapper.findAll('button');
    await buttons[1].trigger('click');
    expect(wrapper.emitted('reblog')).toBeTruthy();
    expect(wrapper.emitted('reblog')![0]).toEqual(['123']);
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
    const buttons = wrapper.findAll('button');
    const favButton = buttons[2];
    expect(favButton.attributes('aria-pressed')).toBe('true');
    expect(favButton.html()).toContain('text-yellow-500');
  });

  it('shows active state when reblogged', () => {
    const wrapper = mountWithPlugins(StatusActions, {
      props: { ...baseProps, reblogged: true },
    });
    const buttons = wrapper.findAll('button');
    const reblogButton = buttons[1];
    expect(reblogButton.attributes('aria-pressed')).toBe('true');
    expect(reblogButton.html()).toContain('text-green-600');
  });

  it('shows active state when bookmarked', () => {
    const wrapper = mountWithPlugins(StatusActions, {
      props: { ...baseProps, bookmarked: true },
    });
    const buttons = wrapper.findAll('button');
    const bookmarkButton = buttons[3];
    expect(bookmarkButton.attributes('aria-pressed')).toBe('true');
    expect(bookmarkButton.html()).toContain('text-indigo-600');
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
    const spans = wrapper.findAll('span.text-xs');
    for (const span of spans) {
      expect(span.text()).toBe('');
    }
  });
});
