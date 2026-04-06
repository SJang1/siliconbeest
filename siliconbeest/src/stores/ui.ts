import { defineStore } from 'pinia';
import { ref, computed, watchEffect } from 'vue';

export type Theme = 'light' | 'dark' | 'system';
export type ColumnType = 'local' | 'federated' | 'notifications';

const THEME_KEY = 'siliconbeest_theme';
const COLUMNS_KEY = 'siliconbeest_columns';
const TRENDING_KEY = 'siliconbeest_show_trending';
const DEFAULT_COLUMNS: ColumnType[] = ['local', 'federated'];

export const useUiStore = defineStore('ui', () => {
  const theme = ref<Theme>((localStorage.getItem(THEME_KEY) as Theme) || 'system');
  const sidebarOpen = ref(false);
  const isMobile = ref(window.innerWidth < 768);
  const composeModalOpen = ref(false);
  const mediaViewerOpen = ref(false);
  const mediaViewerIndex = ref(0);
  const mediaViewerItems = ref<string[]>([]);
  const columns = ref<ColumnType[]>(
    JSON.parse(localStorage.getItem(COLUMNS_KEY) || 'null') || [...DEFAULT_COLUMNS]
  );
  const showTrending = ref<boolean>(
    localStorage.getItem(TRENDING_KEY) !== 'false'
  );

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

  function setShowTrending(show: boolean) {
    showTrending.value = show;
    localStorage.setItem(TRENDING_KEY, String(show));
  }

  function setColumns(newColumns: ColumnType[]) {
    columns.value = newColumns;
    localStorage.setItem(COLUMNS_KEY, JSON.stringify(newColumns));
  }

  function addColumn(type: ColumnType) {
    if (!columns.value.includes(type)) {
      setColumns([...columns.value, type]);
    }
  }

  function removeColumn(type: ColumnType) {
    setColumns(columns.value.filter(c => c !== type));
  }

  function moveColumn(from: number, to: number) {
    const arr = [...columns.value];
    const item = arr.splice(from, 1)[0];
    if (item !== undefined) {
      arr.splice(to, 0, item);
      setColumns(arr);
    }
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
    setShowTrending,
    setColumns,
    addColumn,
    removeColumn,
    moveColumn,
  };
});
