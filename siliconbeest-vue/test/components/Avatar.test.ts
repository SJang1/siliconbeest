import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import Avatar from '@/components/common/Avatar.vue';

describe('Avatar', () => {
  it('renders an image when src is provided', () => {
    const wrapper = mount(Avatar, {
      props: { src: 'https://example.com/avatar.png', alt: 'Test User' },
    });
    const img = wrapper.find('img');
    expect(img.exists()).toBe(true);
    expect(img.attributes('src')).toBe('https://example.com/avatar.png');
  });

  it('renders initials fallback when no src', () => {
    const wrapper = mount(Avatar, {
      props: { alt: 'Test User' },
    });
    expect(wrapper.text()).toContain('TU');
  });

  it('renders single initial for single-word name', () => {
    const wrapper = mount(Avatar, {
      props: { alt: 'Admin' },
    });
    expect(wrapper.text()).toContain('A');
  });

  it('renders ? when alt is empty', () => {
    const wrapper = mount(Avatar, { props: {} });
    expect(wrapper.text()).toContain('?');
  });

  it('does not render img when src is empty', () => {
    const wrapper = mount(Avatar, {
      props: { alt: 'Test' },
    });
    expect(wrapper.find('img').exists()).toBe(false);
  });

  it('applies size classes', () => {
    const wrapper = mount(Avatar, {
      props: { src: 'test.png', alt: 'Test', size: 'lg' },
    });
    const html = wrapper.html();
    expect(html).toContain('w-14');
    expect(html).toContain('h-14');
  });

  it('uses md size by default', () => {
    const wrapper = mount(Avatar, {
      props: { src: 'test.png', alt: 'Test' },
    });
    const html = wrapper.html();
    expect(html).toContain('w-10');
    expect(html).toContain('h-10');
  });

  it('applies sm size classes', () => {
    const wrapper = mount(Avatar, {
      props: { src: 'test.png', alt: 'Test', size: 'sm' },
    });
    const html = wrapper.html();
    expect(html).toContain('w-8');
    expect(html).toContain('h-8');
  });

  it('applies xl size classes', () => {
    const wrapper = mount(Avatar, {
      props: { src: 'test.png', alt: 'Test', size: 'xl' },
    });
    const html = wrapper.html();
    expect(html).toContain('w-20');
    expect(html).toContain('h-20');
  });
});
