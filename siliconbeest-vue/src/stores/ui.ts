import { defineStore } from 'pinia';
import { ref, computed, watchEffect } from 'vue';

export type Theme = 'light' | 'dark' | 'system';

const THEME_KEY = 'siliconbeest_theme';

export const useUiStore = defineStore('ui', () => {
  const theme = ref<Theme>((localStorage.getItem(THEME_KEY) as Theme) || 'system');
  const sidebarOpen = ref(false);
  const isMobile = ref(window.innerWidth < 768);
  const composeModalOpen = ref(false);
  const mediaViewerOpen = ref(false);
  const mediaViewerIndex = ref(0);
  const mediaViewerItems = ref<string[]>([]);

  const isDark = computed(() => {
    if (theme.value === 'system') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    return theme.value === 'dark';
  });

  function setTheme(newTheme: Theme) {
    theme.value = newTheme;
    localStorage.setItem(THEME_KEY, newTheme);
  }

  function toggleSidebar() {
    sidebarOpen.value = !sidebarOpen.value;
  }

  function closeSidebar() {
    sidebarOpen.value = false;
  }

  function openComposeModal() {
    composeModalOpen.value = true;
  }

  function closeComposeModal() {
    composeModalOpen.value = false;
  }

  function openMediaViewer(urls: string[], index = 0) {
    mediaViewerItems.value = urls;
    mediaViewerIndex.value = index;
    mediaViewerOpen.value = true;
  }

  function closeMediaViewer() {
    mediaViewerOpen.value = false;
    mediaViewerItems.value = [];
    mediaViewerIndex.value = 0;
  }

  // Apply dark class to <html>
  watchEffect(() => {
    document.documentElement.classList.toggle('dark', isDark.value);
  });

  // Track window resize
  function handleResize() {
    isMobile.value = window.innerWidth < 768;
    if (!isMobile.value) {
      sidebarOpen.value = false;
    }
  }

  // Call on init
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', handleResize);
  }

  return {
    theme,
    sidebarOpen,
    isMobile,
    isDark,
    composeModalOpen,
    mediaViewerOpen,
    mediaViewerIndex,
    mediaViewerItems,
    setTheme,
    toggleSidebar,
    closeSidebar,
    openComposeModal,
    closeComposeModal,
    openMediaViewer,
    closeMediaViewer,
  };
});
