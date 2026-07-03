import { describe, it, expect, beforeEach } from 'vitest';
import { nextTick } from 'vue';
import {
  useDeckColumns,
  _reloadDeckColumns,
  DECK_COLUMN_ORDER,
} from '@/deck/composables/useDeckColumns';

const STORAGE_KEY = 'siliconbeest_deck_columns';

beforeEach(() => {
  localStorage.clear();
  _reloadDeckColumns();
});

describe('useDeckColumns', () => {
  it('shows all three columns by default in fixed order', () => {
    const { visibleColumns } = useDeckColumns();
    expect(visibleColumns.value).toEqual(['home', 'local', 'federated']);
    expect(DECK_COLUMN_ORDER).toEqual(['home', 'local', 'federated']);
  });

  it('toggle hides and re-shows a column', () => {
    const { visibleColumns, toggle, isVisible } = useDeckColumns();
    toggle('local');
    expect(isVisible('local')).toBe(false);
    expect(visibleColumns.value).toEqual(['home', 'federated']);
    toggle('local');
    expect(visibleColumns.value).toEqual(['home', 'local', 'federated']);
  });

  it('show makes a hidden column visible and keeps order fixed', () => {
    const { visibleColumns, toggle, show } = useDeckColumns();
    toggle('home');
    toggle('federated');
    expect(visibleColumns.value).toEqual(['local']);
    show('home');
    show('home'); // idempotent
    expect(visibleColumns.value).toEqual(['home', 'local']);
  });

  it('persists to localStorage and reloads from it', async () => {
    const { toggle } = useDeckColumns();
    toggle('federated');
    await nextTick();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({
      home: true,
      local: true,
      federated: false,
    });

    _reloadDeckColumns();
    const { visibleColumns } = useDeckColumns();
    expect(visibleColumns.value).toEqual(['home', 'local']);
  });

  it('ignores corrupted storage', () => {
    localStorage.setItem(STORAGE_KEY, '{not json');
    _reloadDeckColumns();
    const { visibleColumns } = useDeckColumns();
    expect(visibleColumns.value).toEqual(['home', 'local', 'federated']);
  });
});
