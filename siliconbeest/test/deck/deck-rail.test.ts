import { beforeEach, describe, expect, it } from 'vitest';
import { mount, renderToString } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import DeckRail from '@/deck/layout/DeckRail.vue';
import type { Instance } from '@/types/mastodon';
import { useAuthStore } from '@/stores/auth';
import { useInstanceStore } from '@/stores/instance';
import { useUiStore } from '@/stores/ui';
import { createTestI18n } from '../helpers';

describe('DeckRail', () => {
  let pinia: ReturnType<typeof createPinia>;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    localStorage.clear();
  });

  async function mountRail(showMobileDeck: boolean, path = '/home') {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/home', name: 'home', component: { template: '<div />' } },
        { path: '/timelines/:type', name: 'timeline', component: { template: '<div />' } },
      ],
    });
    await router.push(path);
    await router.isReady();
    return mount(DeckRail, {
      props: { showMobileDeck },
      global: {
        plugins: [pinia, createTestI18n(), router],
        stubs: { Avatar: true },
      },
    });
  }

  it('only describes the Columns button with guidance rendered by the desktop branch', async () => {
    const ui = useUiStore();
    ui.hydrateFromServer('token', {
      'ui:columns': '[]',
      'ui:show_trending': null,
    });

    const desktop = await mountRail(false);
    expect(desktop.get('#deck-column-picker-button').attributes('aria-describedby'))
      .toBe('deck-empty-columns-guidance');
    desktop.unmount();

    const mobile = await mountRail(true);
    expect(mobile.get('#deck-column-picker-button').attributes('aria-describedby'))
      .toBeUndefined();
  });

  it('allows the desktop rail to scroll when the viewport is too short', async () => {
    const rail = await mountRail(false);

    expect(rail.classes()).toEqual(expect.arrayContaining([
      'min-h-0',
      'overflow-y-auto',
      'overscroll-y-contain',
    ]));
  });

  it('shows an active direct AI recommendation route only when enabled', async () => {
    useAuthStore().setToken('rail-token');
    useInstanceStore().instance = {
      configuration: {
        ai: { enabled: true, recommended_timeline: true, image_description: false },
      },
    } as Instance;

    const rail = await mountRail(false, '/timelines/recommended');
    const link = rail.get('[data-recommended-nav]');

    expect(link.attributes('href')).toBe('/timelines/recommended');
    expect(link.classes()).toContain('dk-rail-item-active');
  });

  it('includes AI recommendations in server-rendered navigation when enabled', async () => {
    useAuthStore().setToken('rail-ssr-token');
    useInstanceStore().instance = {
      configuration: {
        ai: { enabled: true, recommended_timeline: true, image_description: false },
      },
    } as Instance;

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/home', name: 'home', component: { template: '<div />' } },
        { path: '/timelines/:type', name: 'timeline', component: { template: '<div />' } },
      ],
    });
    await router.push('/home');
    await router.isReady();

    const html = await renderToString(DeckRail, {
      props: { showMobileDeck: false },
      global: {
        plugins: [pinia, createTestI18n(), router],
        stubs: { Avatar: true },
      },
    });

    expect(html).toContain('data-recommended-nav');
    expect(html).toContain('href="/timelines/recommended"');
  });

  it('hides the AI recommendation route when disabled', async () => {
    useAuthStore().setToken('rail-token');
    useInstanceStore().instance = {
      configuration: {
        ai: { enabled: true, recommended_timeline: false, image_description: false },
      },
    } as Instance;

    const rail = await mountRail(false);

    expect(rail.find('[data-recommended-nav]').exists()).toBe(false);
  });

  it('shows recommended as the first disabled column option when enabled', async () => {
    useAuthStore().setToken('rail-token');
    useInstanceStore().instance = {
      configuration: {
        ai: { enabled: true, recommended_timeline: true, image_description: false },
      },
    } as Instance;
    useUiStore().hydrateFromServer('rail-token', {
      'ui:columns': '[]',
      'ui:show_trending': null,
    });
    const rail = await mountRail(false);

    await rail.get('#deck-column-picker-button').trigger('click');

    const toggles = rail.findAll('input[type="checkbox"]');
    expect(toggles[0]?.attributes('aria-label')).toBe('Toggle AI recommendations column');
    expect((toggles[0]?.element as HTMLInputElement).checked).toBe(false);
  });
});
