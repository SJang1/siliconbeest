import { describe, it, expect } from 'vitest';
import FollowButton from '@/components/account/FollowButton.vue';
import { mountWithPlugins } from '../helpers';

describe('FollowButton', () => {
  it('shows Follow text when not following', () => {
    const wrapper = mountWithPlugins(FollowButton, {
      props: { accountId: '1', following: false },
    });
    expect(wrapper.text()).toContain('Follow');
  });

  it('shows Following text when following (Unfollow on hover)', () => {
    const wrapper = mountWithPlugins(FollowButton, {
      props: { accountId: '1', following: true },
    });
    expect(wrapper.text()).toContain('Following');
  });

  it('shows Pending text when requested', () => {
    const wrapper = mountWithPlugins(FollowButton, {
      props: { accountId: '1', requested: true },
    });
    expect(wrapper.text()).toContain('Pending');
  });

  it('emits toggle event with accountId on click', async () => {
    const wrapper = mountWithPlugins(FollowButton, {
      props: { accountId: '42', following: false },
    });
    await wrapper.find('button').trigger('click');
    expect(wrapper.emitted('toggle')).toBeTruthy();
    expect(wrapper.emitted('toggle')![0]).toEqual(['42']);
  });

  it('is disabled when blocked', () => {
    const wrapper = mountWithPlugins(FollowButton, {
      props: { accountId: '1', blocked: true },
    });
    const button = wrapper.find('button');
    expect(button.attributes('disabled')).toBeDefined();
  });

  it('applies follow styling when not following', () => {
    const wrapper = mountWithPlugins(FollowButton, {
      props: { accountId: '1', following: false },
    });
    expect(wrapper.find('button').html()).toContain('bg-indigo-600');
  });

  it('applies different styling when following', () => {
    const wrapper = mountWithPlugins(FollowButton, {
      props: { accountId: '1', following: true },
    });
    expect(wrapper.find('button').html()).toContain('border');
  });

  it('applies red styling when blocked', () => {
    const wrapper = mountWithPlugins(FollowButton, {
      props: { accountId: '1', blocked: true },
    });
    expect(wrapper.find('button').html()).toContain('bg-red-600');
  });
});
