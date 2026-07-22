import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useUiStore } from '@/stores/ui';
import { getPreferences, updatePreferences } from '@/api/mastodon/preferences';

vi.mock('@/api/mastodon/preferences', () => ({
  getPreferences: vi.fn(),
  updatePreferences: vi.fn(async () => ({ data: {}, headers: new Headers() })),
}));

type PreferenceResponse = Awaited<ReturnType<typeof getPreferences>>;

function preferenceResponse(
  columns: string,
  showTrending: string | boolean | null = null,
): PreferenceResponse {
  return {
    data: {
      'posting:default:visibility': 'public',
      'posting:default:sensitive': false,
      'posting:default:language': null,
      'reading:expand:media': 'default',
      'reading:expand:spoilers': false,
      'ui:columns': columns,
      'ui:show_trending': showTrending,
    },
    headers: new Headers(),
  };
}

describe('UI Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.removeItem("siliconbeest_token"); localStorage.removeItem("siliconbeest_theme");
    vi.clearAllMocks();
  });

  describe('Server-synced columns', () => {
    it('starts with no desktop columns selected', () => {
      const store = useUiStore();
      expect(store.columns).toEqual([]);
    });

    it('hydrates selected columns in server order and records the token for saves', () => {
      const store = useUiStore();

      store.hydrateFromServer('server-token', {
        'ui:columns': '["notifications","home","local"]',
        'ui:show_trending': false,
      });

      expect(store.columns).toEqual(['notifications', 'home', 'local']);
      expect(store.showTrending).toBe(false);
      expect(store.serverLoaded).toBe(true);

      store.setColumns(['local']);
      expect(updatePreferences).toHaveBeenCalledWith('server-token', {
        'ui:columns': '["local"]',
      });
    });

    it('preserves the optional recommended deck column in server preferences', () => {
      const store = useUiStore();

      store.hydrateFromServer('server-token', {
        'ui:columns': '["recommended","home"]',
        'ui:show_trending': null,
      });

      expect(store.columns).toEqual(['recommended', 'home']);
    });

    it.each([
      ['missing response', null],
      ['null preference', { 'ui:columns': null, 'ui:show_trending': null }],
      ['empty selection', { 'ui:columns': '[]', 'ui:show_trending': null }],
      ['malformed JSON', { 'ui:columns': '[not-json', 'ui:show_trending': null }],
      ['non-array JSON', { 'ui:columns': '{"home":true}', 'ui:show_trending': null }],
    ])('hydrates %s as no selected columns', (_label, preferences) => {
      const store = useUiStore();
      store.columns = ['home'];

      store.hydrateFromServer('server-token', preferences);

      expect(store.columns).toEqual([]);
      expect(store.serverLoaded).toBe(true);
    });

    it('drops unknown and duplicate server column values', () => {
      const store = useUiStore();

      store.hydrateFromServer('server-token', {
        'ui:columns': '["home","bogus","home","search"]',
        'ui:show_trending': null,
      });

      expect(store.columns).toEqual(['home', 'search']);
    });

    it('keeps SSR-hydrated columns when a later client refresh fails', async () => {
      const store = useUiStore();
      store.hydrateFromServer('server-token', {
        'ui:columns': '["notifications","home"]',
        'ui:show_trending': null,
      });
      vi.mocked(getPreferences).mockRejectedValueOnce(new Error('offline'));

      await store.loadFromServer('server-token');

      expect(store.columns).toEqual(['notifications', 'home']);
      expect(store.serverLoaded).toBe(true);
    });

    it('keeps a local column change when an older refresh finishes later', async () => {
      const store = useUiStore();
      store.hydrateFromServer('current-token', {
        'ui:columns': '["home"]',
        'ui:show_trending': true,
      });
      let resolveRequest!: (value: PreferenceResponse) => void;
      vi.mocked(getPreferences).mockReturnValueOnce(new Promise((resolve) => {
        resolveRequest = resolve;
      }));

      const pending = store.loadFromServer('current-token');
      store.setColumns(['local']);

      expect(updatePreferences).toHaveBeenCalledWith('current-token', {
        'ui:columns': '["local"]',
      });

      resolveRequest(preferenceResponse('["federated"]'));
      await pending;

      expect(store.columns).toEqual(['local']);
    });

    it('persists a local change made before the initial preference load finishes', async () => {
      const store = useUiStore();
      let resolveRequest!: (value: PreferenceResponse) => void;
      vi.mocked(getPreferences).mockReturnValueOnce(new Promise((resolve) => {
        resolveRequest = resolve;
      }));

      const pending = store.loadFromServer('current-token');
      store.setColumns(['local']);

      expect(updatePreferences).toHaveBeenCalledWith('current-token', {
        'ui:columns': '["local"]',
      });

      resolveRequest(preferenceResponse('["home"]'));
      await pending;
      expect(store.columns).toEqual(['local']);
    });

    it('keeps a local trending change when an older refresh finishes later', async () => {
      const store = useUiStore();
      store.hydrateFromServer('current-token', {
        'ui:columns': '["home"]',
        'ui:show_trending': true,
      });
      let resolveRequest!: (value: PreferenceResponse) => void;
      vi.mocked(getPreferences).mockReturnValueOnce(new Promise((resolve) => {
        resolveRequest = resolve;
      }));

      const pending = store.loadFromServer('current-token');
      store.setShowTrending(false);

      expect(updatePreferences).toHaveBeenCalledWith('current-token', {
        'ui:show_trending': 'false',
      });

      resolveRequest(preferenceResponse('["federated"]', true));
      await pending;

      expect(store.showTrending).toBe(false);
      expect(store.columns).toEqual(['home']);
    });

    it('does not leak hydrated columns to a different token after a failed refresh', async () => {
      const store = useUiStore();
      store.hydrateFromServer('first-token', {
        'ui:columns': '["notifications","home"]',
        'ui:show_trending': null,
      });
      vi.mocked(getPreferences).mockRejectedValueOnce(new Error('offline'));

      await store.loadFromServer('second-token');

      expect(store.columns).toEqual([]);
    });

    it('ignores a preference response that finishes after logout reset', async () => {
      const store = useUiStore();
      let resolveRequest!: (value: PreferenceResponse) => void;
      vi.mocked(getPreferences).mockReturnValueOnce(new Promise((resolve) => {
        resolveRequest = resolve;
      }));

      const pending = store.loadFromServer('old-token');
      store.resetToDefaults();
      resolveRequest(preferenceResponse('["notifications","home"]'));
      await pending;

      expect(store.columns).toEqual([]);
      store.setColumns(['local']);
      expect(updatePreferences).not.toHaveBeenCalled();
    });

    it('lets only the newest overlapping account request apply', async () => {
      const store = useUiStore();
      let resolveFirst!: (value: PreferenceResponse) => void;
      let resolveSecond!: (value: PreferenceResponse) => void;
      vi.mocked(getPreferences)
        .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }))
        .mockReturnValueOnce(new Promise((resolve) => { resolveSecond = resolve; }));

      const first = store.loadFromServer('first-token');
      const second = store.loadFromServer('second-token');
      resolveSecond(preferenceResponse('["local"]'));
      await second;
      resolveFirst(preferenceResponse('["home"]'));
      await first;

      expect(store.columns).toEqual(['local']);
      store.setColumns(['federated']);
      expect(updatePreferences).toHaveBeenCalledWith('second-token', {
        'ui:columns': '["federated"]',
      });
    });

    it('keeps the older response stale even when it finishes first', async () => {
      const store = useUiStore();
      let resolveFirst!: (value: PreferenceResponse) => void;
      let resolveSecond!: (value: PreferenceResponse) => void;
      vi.mocked(getPreferences)
        .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }))
        .mockReturnValueOnce(new Promise((resolve) => { resolveSecond = resolve; }));

      const first = store.loadFromServer('first-token');
      const second = store.loadFromServer('second-token');
      resolveFirst(preferenceResponse('["home"]'));
      await first;
      expect(store.columns).toEqual([]);

      resolveSecond(preferenceResponse('["federated"]'));
      await second;

      expect(store.columns).toEqual(['federated']);
    });

    it('reset clears columns and the server token', () => {
      const store = useUiStore();
      store.hydrateFromServer('server-token', {
        'ui:columns': '["home"]',
        'ui:show_trending': null,
      });

      store.resetToDefaults();
      store.setColumns(['local']);

      expect(store.columns).toEqual(['local']);
      expect(store.serverLoaded).toBe(false);
      expect(updatePreferences).not.toHaveBeenCalled();
    });
  });

  describe('Theme', () => {
    it('defaults to system theme', () => {
      const store = useUiStore();
      expect(store.theme).toBe('system');
    });

    it('sets theme to light', () => {
      const store = useUiStore();
      store.setTheme('light');
      expect(store.theme).toBe('light');
    });

    it('sets theme to dark', () => {
      const store = useUiStore();
      store.setTheme('dark');
      expect(store.theme).toBe('dark');
      expect(store.isDark).toBe(true);
    });

    it('persists theme to localStorage', () => {
      const store = useUiStore();
      store.setTheme('dark');
      expect(localStorage.getItem('siliconbeest_theme')).toBe('dark');
    });

    it('restores theme from localStorage', () => {
      localStorage.setItem('siliconbeest_theme', 'light');
      const store = useUiStore();
      expect(store.theme).toBe('light');
    });

    it('isDark is false for light theme', () => {
      const store = useUiStore();
      store.setTheme('light');
      expect(store.isDark).toBe(false);
    });

    it('isDark is true for dark theme', () => {
      const store = useUiStore();
      store.setTheme('dark');
      expect(store.isDark).toBe(true);
    });
  });

  describe('Sidebar', () => {
    it('sidebar is closed by default', () => {
      const store = useUiStore();
      expect(store.sidebarOpen).toBe(false);
    });

    it('toggleSidebar opens sidebar', () => {
      const store = useUiStore();
      store.toggleSidebar();
      expect(store.sidebarOpen).toBe(true);
    });

    it('toggleSidebar closes opened sidebar', () => {
      const store = useUiStore();
      store.toggleSidebar(); // open
      store.toggleSidebar(); // close
      expect(store.sidebarOpen).toBe(false);
    });

    it('closeSidebar closes the sidebar', () => {
      const store = useUiStore();
      store.toggleSidebar(); // open
      store.closeSidebar();
      expect(store.sidebarOpen).toBe(false);
    });
  });

  describe('Compose Modal', () => {
    it('compose modal is closed by default', () => {
      const store = useUiStore();
      expect(store.composeModalOpen).toBe(false);
    });

    it('openComposeModal opens the modal', () => {
      const store = useUiStore();
      store.openComposeModal();
      expect(store.composeModalOpen).toBe(true);
    });

    it('closeComposeModal closes the modal', () => {
      const store = useUiStore();
      store.openComposeModal();
      store.closeComposeModal();
      expect(store.composeModalOpen).toBe(false);
    });

    it('openComposeModal stores prefill text for the composer', () => {
      const store = useUiStore();
      store.openComposeModal({ prefillText: 'shared text\n\n#tag' });
      expect(store.composeModalOpen).toBe(true);
      expect(store.composePrefillText).toBe('shared text\n\n#tag');
    });

    it('opening without options clears any previous prefill', () => {
      const store = useUiStore();
      store.openComposeModal({ prefillText: 'shared text' });
      store.closeComposeModal();
      store.openComposeModal();
      expect(store.composePrefillText).toBe('');
    });

    it('closeComposeModal clears the prefill text', () => {
      const store = useUiStore();
      store.openComposeModal({ prefillText: 'shared text' });
      store.closeComposeModal();
      expect(store.composePrefillText).toBe('');
    });
  });

  describe('Media Viewer', () => {
    it('opens with urls and index', () => {
      const store = useUiStore();
      store.openMediaViewer(['a.png', 'b.png'], 1);
      expect(store.mediaViewerOpen).toBe(true);
      expect(store.mediaViewerItems).toEqual(['a.png', 'b.png']);
      expect(store.mediaViewerIndex).toBe(1);
    });

    it('closes and resets state', () => {
      const store = useUiStore();
      store.openMediaViewer(['a.png'], 0);
      store.closeMediaViewer();
      expect(store.mediaViewerOpen).toBe(false);
      expect(store.mediaViewerItems).toEqual([]);
      expect(store.mediaViewerIndex).toBe(0);
    });
  });
});
