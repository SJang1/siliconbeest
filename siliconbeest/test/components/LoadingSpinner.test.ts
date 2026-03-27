import { describe, it, expect } from 'vitest';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import { mountWithPlugins } from '../helpers';

describe('LoadingSpinner', () => {
  it('renders with role=status', () => {
    const wrapper = mountWithPlugins(LoadingSpinner);
    expect(wrapper.find('[role="status"]').exists()).toBe(true);
  });

  it('renders an SVG spinner element', () => {
    const wrapper = mountWithPlugins(LoadingSpinner);
    expect(wrapper.find('svg').exists()).toBe(true);
  });

  it('has animate-spin class for animation', () => {
    const wrapper = mountWithPlugins(LoadingSpinner);
    const svg = wrapper.find('svg');
    expect(svg.classes()).toContain('animate-spin');
  });

  it('contains a screen-reader-only text', () => {
    const wrapper = mountWithPlugins(LoadingSpinner);
    const srOnly = wrapper.find('.sr-only');
    expect(srOnly.exists()).toBe(true);
    expect(srOnly.text()).toBeTruthy();
  });
});
