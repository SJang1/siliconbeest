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
  quotePolicyAllows: true,
};

function buttonByText(wrapper: ReturnType<typeof mountWithPlugins>, text: string) {
  return wrapper.findAll('button').find((b) => b.text().includes(text));
}

describe('DeckStatusActions', () => {
  it('renders a compact row: reply, boost chooser, star chooser, bookmark, more', () => {
    const wrapper = mountWithPlugins(DeckStatusActions, { props: baseProps });
    // 5 visible buttons — repost/quote and favourite/react are collapsed into choosers
    expect(wrapper.findAll('button').length).toBe(5);
  });

  it('emits reply directly', async () => {
    const wrapper = mountWithPlugins(DeckStatusActions, { props: baseProps });
    await wrapper.findAll('button')[0]!.trigger('click');
    expect(wrapper.emitted('reply')![0]).toEqual(['123']);
  });

  it('boost chooser asks repost or quote', async () => {
    const wrapper = mountWithPlugins(DeckStatusActions, { props: baseProps });
    await wrapper.findAll('button')[1]!.trigger('click');
    expect(wrapper.emitted('overlay')![0]).toEqual([true]);

    await buttonByText(wrapper, 'Boost')!.trigger('click');
    expect(wrapper.emitted('reblog')![0]).toEqual(['123']);

    // Menu closed after picking
    expect(buttonByText(wrapper, 'Quote')).toBeUndefined();
  });

  it('boost chooser can quote instead', async () => {
    const wrapper = mountWithPlugins(DeckStatusActions, { props: baseProps });
    await wrapper.findAll('button')[1]!.trigger('click');
    await buttonByText(wrapper, 'Quote')!.trigger('click');
    expect(wrapper.emitted('quote')![0]).toEqual(['123']);
    expect(wrapper.emitted('reblog')).toBeFalsy();
  });

  it('star chooser asks favourite or emoji reaction', async () => {
    const wrapper = mountWithPlugins(DeckStatusActions, { props: baseProps });
    await wrapper.findAll('button')[2]!.trigger('click');

    await buttonByText(wrapper, 'Favourite')!.trigger('click');
    expect(wrapper.emitted('favourite')![0]).toEqual(['123']);

    await wrapper.findAll('button')[2]!.trigger('click');
    await buttonByText(wrapper, 'React with emoji')!.trigger('click');
    expect(wrapper.emitted('react')![0]).toEqual(['123']);
  });

  it('bookmark emits directly; share lives in the more menu', async () => {
    const wrapper = mountWithPlugins(DeckStatusActions, { props: baseProps });
    const buttons = wrapper.findAll('button');
    await buttons[3]!.trigger('click');
    expect(wrapper.emitted('bookmark')![0]).toEqual(['123']);

    await buttons[4]!.trigger('click');
    await buttonByText(wrapper, 'Share')!.trigger('click');
    expect(wrapper.emitted('share')![0]).toEqual(['123']);
  });

  it('disables repost for private posts but keeps the chooser usable', async () => {
    const wrapper = mountWithPlugins(DeckStatusActions, {
      props: { ...baseProps, visibility: 'private' },
    });
    await wrapper.findAll('button')[1]!.trigger('click');
    const repost = buttonByText(wrapper, 'Boost')!;
    expect(repost.attributes('disabled')).toBeDefined();
    await repost.trigger('click');
    expect(wrapper.emitted('reblog')).toBeFalsy();
  });
});
