import { defineStore } from 'pinia';
import { ref, computed, watchEffect } from 'vue';
import { getPreferences, updatePreferences } from '@/api/mastodon/preferences';

export type Theme = 'light' | 'dark' | 'system';
export type ColumnType = 'home' | 'local' | 'federated' | 'notifications';

const THEME_KEY = 'siliconbeest_theme';
const DEFAULT_COLUMNS: ColumnType[] = ['home', 'local', 'federated'];

export const useUiStore = defineStore('ui', () => {
  const theme = ref<Theme>((localStorage.getItem(THEME_KEY) as Theme) || 'system');
  const sidebarOpen = ref(false);
  const isMobile = ref(window.innerWidth < 768);
  const composeModalOpen = ref(false);
  const mediaViewerOpen = ref(false);
  const mediaViewerIndex = ref(0);
  const mediaViewerItems = ref<string[]>([]);
  const columns = ref<ColumnType[]>([...DEFAULT_COLUMNS]);
  const showTrending = ref(true);
  const serverLoaded = ref(false);
  const saving = ref(false);

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

  /** Token stored externally — only passed when calling server-synced setters */
  let _token: string | null = null;

  async function saveToServer(prefs: Record<string, string>) {
    if (!_token) return;
    saving.value = true;
    try {
      await updatePreferences(_token, prefs);
    } finally {
      saving.value = false;
    }
  }

  function setShowTrending(show: boolean) {
    showTrending.value = show;
    saveToServer({ 'ui:show_trending': String(show) });
  }

  function setColumns(newColumns: ColumnType[]) {
    columns.value = newColumns;
    saveToServer({ 'ui:columns': JSON.stringify(newColumns) });
  }

  function addColumn(type: ColumnType) {
    setColumns([...columns.value, type]);
  }

  function removeColumnAt(index: number) {
    const arr = [...columns.value];
    arr.splice(index, 1);
    setColumns(arr);
  }

  function moveColumn(from: number, to: number) {
    const arr = [...columns.value];
    const item = arr.splice(from, 1)[0];
    if (item !== undefined) {
      arr.splice(to, 0, item);
      setColumns(arr);
    }
  }

  async function loadFromServer(token: string) {
    _token = token;
    try {
      const { data } = await getPreferences(token);
      if (data['ui:columns']) {
        const parsed = JSON.parse(data['ui:columns']) as ColumnType[];
        if (Array.isArray(parsed)) {
          columns.value = parsed;
        }
      }
      if (data['ui:show_trending'] !== null && data['ui:show_trending'] !== undefined) {
        const v = data['ui:show_trending'];
        showTrending.value = v !== false && v !== 'false';
      }
      serverLoaded.value = true;
    } catch {
      // Use defaults on failure
    }
  }

  function resetToDefaults() {
    _token = null;
    columns.value = [...DEFAULT_COLUMNS];
    showTrending.value = true;
    serverLoaded.value = false;
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
    columns,
    showTrending,
    serverLoaded,
    saving,
    setShowTrending,
    setColumns,
    addColumn,
    removeColumnAt,
    moveColumn,
    loadFromServer,
    resetToDefaults,
  };
});
