import { defineStore } from 'pinia';
import { ref, computed, watchEffect } from 'vue';
import {
  getPreferences,
  updatePreferences,
  type Preferences,
} from '@/api/mastodon/preferences';

export type Theme = 'light' | 'dark' | 'system';
export type StandardColumnType =
  | 'home'
  | 'social'
  | 'local'
  | 'federated'
  | 'notifications'
  | 'search'
  | 'follow_requests';
export type ColumnType = 'recommended' | StandardColumnType;

const THEME_KEY = 'siliconbeest_theme';
const MOBILE_COLUMN_KEY = 'siliconbeest_mobile_column';
const DEFAULT_COLUMNS: ColumnType[] = [];
/** Column types the Aurora design's mobile deck can render. */
export const ALL_COLUMNS: StandardColumnType[] = ['home', 'local', 'federated', 'notifications'];
/** Every column type (superset — the deck design supports them all). */
const VALID_MOBILE_COLUMNS: ColumnType[] = [
  'recommended',
  'home',
  'social',
  'local',
  'federated',
  'notifications',
  'search',
  'follow_requests',
];

export type ServerUiPreferences = Pick<
  Preferences,
  'ui:columns' | 'ui:show_trending'
>;

function parseServerColumns(value: string | null | undefined): ColumnType[] {
  if (!value) return [];

  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter(
      (column, index): column is ColumnType =>
        typeof column === 'string' &&
        VALID_MOBILE_COLUMNS.includes(column as ColumnType) &&
        parsed.indexOf(column) === index,
    );
  } catch {
    return [];
  }
}

function loadMobileColumn(): ColumnType {
  if (typeof localStorage === 'undefined') return 'home';
  const stored = localStorage.getItem(MOBILE_COLUMN_KEY) as ColumnType | null;
  return stored && VALID_MOBILE_COLUMNS.includes(stored) ? stored : 'home';
}

function persistTheme(theme: Theme) {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(THEME_KEY, theme);
  }
  if (typeof document !== 'undefined') {
    document.cookie = `${THEME_KEY}=${encodeURIComponent(theme)}; Path=/; Max-Age=31536000; SameSite=Lax`;
  }
}

export const useUiStore = defineStore('ui', () => {
  const theme = ref<Theme>(
    typeof localStorage === 'undefined'
      ? 'system'
      : ((localStorage.getItem(THEME_KEY) as Theme) || 'system'),
  );
  const sidebarOpen = ref(false);
  // Mirror Tailwind's `md` breakpoint with matchMedia rather than
  // window.innerWidth: on mobile browsers the layout viewport can report a
  // desktop-ish width (e.g. 980px) while the CSS media queries already
  // resolve against the device width, which left isMobile=false on phones
  // and rendered the desktop deck there.
  const MOBILE_MEDIA_QUERY = '(max-width: 767px)';
  const isMobile = ref(
    typeof window !== 'undefined' ? window.matchMedia(MOBILE_MEDIA_QUERY).matches : false,
  );
  const composeModalOpen = ref(false);
  // Text to seed the composer with when the modal opens (e.g. /share intent).
  // Cleared on close so a later plain compose starts empty.
  const composePrefillText = ref('');
  const mediaViewerOpen = ref(false);
  const mediaViewerIndex = ref(0);
  const mediaViewerItems = ref<string[]>([]);
  const columns = ref<ColumnType[]>([...DEFAULT_COLUMNS]);
  // Mobile deck: which column is shown, and whether the column picker sheet is open
  const mobileColumn = ref<ColumnType>(loadMobileColumn());
  const deckMenuOpen = ref(false);
  const showTrending = ref(true);
  const serverLoaded = ref(false);
  const saving = ref(false);

  const isDark = computed(() => {
    if (theme.value === 'system') {
      return typeof window !== 'undefined'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
        : false;
    }
    return theme.value === 'dark';
  });

  function setTheme(newTheme: Theme) {
    theme.value = newTheme;
    persistTheme(newTheme);
  }

  function toggleSidebar() {
    sidebarOpen.value = !sidebarOpen.value;
  }

  function closeSidebar() {
    sidebarOpen.value = false;
  }

  function setMobileColumn(type: ColumnType) {
    mobileColumn.value = type;
    deckMenuOpen.value = false;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(MOBILE_COLUMN_KEY, type);
    }
  }

  function toggleDeckMenu() {
    deckMenuOpen.value = !deckMenuOpen.value;
  }

  function closeDeckMenu() {
    deckMenuOpen.value = false;
  }

  function openComposeModal(options?: { prefillText?: string }) {
    composePrefillText.value = options?.prefillText ?? '';
    composeModalOpen.value = true;
  }

  function closeComposeModal() {
    composeModalOpen.value = false;
    composePrefillText.value = '';
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
  /** Account whose preferences are currently represented by store state. */
  let _loadedToken: string | null = null;
  // Invalidates preference requests that finish after logout, account changes,
  // or a newer SSR/client hydration has already supplied authoritative state.
  let preferenceLoadGeneration = 0;

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
    // A local choice made after a refresh started is newer than that refresh.
    // Invalidate its response before updating state or persisting the choice.
    preferenceLoadGeneration += 1;
    showTrending.value = show;
    saveToServer({ 'ui:show_trending': String(show) });
  }

  function setColumns(newColumns: ColumnType[]) {
    // Prevent an in-flight preference refresh from restoring the selection the
    // user just replaced locally.
    preferenceLoadGeneration += 1;
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

  /**
   * Apply server-provided UI preferences synchronously. The SSR /home page
   * uses this before rendering the deck, and hydration applies the same
   * payload before mounting any timeline columns.
   */
  function applyServerPreferences(token: string, data: ServerUiPreferences | null) {
    _token = token;
    _loadedToken = token;
    columns.value = parseServerColumns(data?.['ui:columns']);
    showTrending.value = true;

    const trending = data?.['ui:show_trending'];
    if (trending !== null && trending !== undefined) {
      showTrending.value = trending !== false && trending !== 'false';
    }

    serverLoaded.value = true;
  }

  function hydrateFromServer(token: string, data: ServerUiPreferences | null) {
    preferenceLoadGeneration += 1;
    applyServerPreferences(token, data);
  }

  async function loadFromServer(token: string) {
    // Set the token before starting I/O so local changes made while this
    // request is pending can still be persisted. The generation check below
    // keeps the older server response from overwriting those changes.
    _token = token;
    const generation = ++preferenceLoadGeneration;
    try {
      const { data } = await getPreferences(token);
      if (generation !== preferenceLoadGeneration) return;
      applyServerPreferences(token, data);
    } catch {
      if (generation !== preferenceLoadGeneration) return;
      // A successful SSR bootstrap may already hold the correct selection.
      // Do not erase it if the client's background refresh fails later.
      const alreadyLoadedForToken = serverLoaded.value && _loadedToken === token;
      if (!alreadyLoadedForToken) {
        applyServerPreferences(token, null);
      }
    }
  }

  function resetToDefaults() {
    preferenceLoadGeneration += 1;
    _token = null;
    _loadedToken = null;
    columns.value = [...DEFAULT_COLUMNS];
    showTrending.value = true;
    serverLoaded.value = false;
  }

  // Apply dark class to <html>
  watchEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.classList.toggle('dark', isDark.value);
      document.documentElement.style.colorScheme = isDark.value ? 'dark' : 'light';
    }
  });

  // Track viewport changes via the same media query CSS uses
  if (typeof window !== 'undefined') {
    const mediaQuery = window.matchMedia(MOBILE_MEDIA_QUERY);
    const syncIsMobile = () => {
      isMobile.value = mediaQuery.matches;
      if (!mediaQuery.matches) {
        sidebarOpen.value = false;
      }
    };
    syncIsMobile();
    mediaQuery.addEventListener('change', syncIsMobile);
    // Fallback for environments where the media query result settles late
    window.addEventListener('resize', syncIsMobile);
  }

  return {
    theme,
    sidebarOpen,
    isMobile,
    isDark,
    composeModalOpen,
    composePrefillText,
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
    mobileColumn,
    deckMenuOpen,
    setMobileColumn,
    toggleDeckMenu,
    closeDeckMenu,
    showTrending,
    serverLoaded,
    saving,
    setShowTrending,
    setColumns,
    addColumn,
    removeColumnAt,
    moveColumn,
    hydrateFromServer,
    loadFromServer,
    resetToDefaults,
  };
});
