import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useUiStore } from '@/stores/ui';

describe('UI Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.removeItem("siliconbeest_token"); localStorage.removeItem("siliconbeest_theme");
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
