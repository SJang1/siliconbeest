import { computed, ref, watch } from 'vue';

export type DeckColumnKey = 'home' | 'local' | 'federated';

/** Fixed column order — no drag-reorder in v1 (see the Deck Mode spec). */
export const DECK_COLUMN_ORDER: DeckColumnKey[] = ['home', 'local', 'federated'];

const STORAGE_KEY = 'siliconbeest_deck_columns';

type Visibility = Record<DeckColumnKey, boolean>;

function defaultVisibility(): Visibility {
  return { home: true, local: true, federated: true };
}

function load(): Visibility {
  if (typeof localStorage === 'undefined') return defaultVisibility();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultVisibility();
    const parsed = JSON.parse(raw) as Partial<Visibility>;
    const result = defaultVisibility();
    for (const key of DECK_COLUMN_ORDER) {
      if (typeof parsed?.[key] === 'boolean') result[key] = parsed[key]!;
    }
    return result;
  } catch {
    return defaultVisibility();
  }
}

// App-wide singleton so the rail and the deck view share one state
const visibility = ref<Visibility>(load());

watch(
  visibility,
  (v) => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(v));
    }
  },
  { deep: true },
);

export function useDeckColumns() {
  const visibleColumns = computed(() => DECK_COLUMN_ORDER.filter((k) => visibility.value[k]));

  function isVisible(key: DeckColumnKey): boolean {
    return visibility.value[key];
  }

  function toggle(key: DeckColumnKey) {
    visibility.value[key] = !visibility.value[key];
  }

  function show(key: DeckColumnKey) {
    visibility.value[key] = true;
  }

  return { visibility, visibleColumns, isVisible, toggle, show };
}

/** Test-only: re-read state from localStorage. */
export function _reloadDeckColumns() {
  visibility.value = load();
}
