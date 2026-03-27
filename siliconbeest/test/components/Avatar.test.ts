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

  it('renders default avatar when no src', () => {
    const wrapper = mount(Avatar, {
      props: { alt: 'Test User' },
    });
    const img = wrapper.find('img');
    expect(img.exists()).toBe(true);
    expect(img.attributes('src')).toContain('data:image/svg+xml');
  });

  it('renders default avatar for single-word name', () => {
    const wrapper = mount(Avatar, {
      props: { alt: 'Admin' },
    });
    const img = wrapper.find('img');
    expect(img.exists()).toBe(true);
    expect(img.attributes('src')).toContain('data:image/svg+xml');
  });

  it('renders default avatar when alt is empty', () => {
    const wrapper = mount(Avatar, { props: {} });
    const img = wrapper.find('img');
    expect(img.exists()).toBe(true);
  });

  it('always renders img element (uses default avatar)', () => {
    const wrapper = mount(Avatar, {
      props: { alt: 'Test' },
    });
    expect(wrapper.find('img').exists()).toBe(true);
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
