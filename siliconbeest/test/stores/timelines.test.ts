import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useTimelinesStore } from '@/stores/timelines';

// Mock API calls
vi.mock('@/api/mastodon/timelines', () => ({
  getHomeTimeline: vi.fn(),
  getPublicTimeline: vi.fn(),
  getTagTimeline: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  parseLinkHeader: vi.fn(() => ({})),
}));

describe('Timelines Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  describe('getTimeline', () => {
    it('creates empty timeline on first access', () => {
      const store = useTimelinesStore();
      const timeline = store.getTimeline('home');
      expect(timeline.statusIds).toEqual([]);
      expect(timeline.loading).toBe(false);
      expect(timeline.hasMore).toBe(true);
      expect(timeline.error).toBeNull();
      expect(timeline.newStatusIds).toEqual([]);
    });

    it('returns same timeline on repeated access', () => {
      const store = useTimelinesStore();
      const first = store.getTimeline('home');
      first.statusIds.push('1');
      const second = store.getTimeline('home');
      expect(second.statusIds).toEqual(['1']);
    });

    it('uses tag key for tag timelines', () => {
      const store = useTimelinesStore();
      const tagTimeline = store.getTimeline('tag', 'rust');
      tagTimeline.statusIds.push('100');
      // Different tag should create separate timeline
      const otherTag = store.getTimeline('tag', 'vue');
      expect(otherTag.statusIds).toEqual([]);
      // Original tag timeline should be intact
      expect(store.getTimeline('tag', 'rust').statusIds).toEqual(['100']);
    });
  });

  describe('prependStatus', () => {
    it('adds status id to newStatusIds', () => {
      const store = useTimelinesStore();
      store.prependStatus('home', '42');
      const timeline = store.getTimeline('home');
      expect(timeline.newStatusIds).toContain('42');
    });

    it('prepends at beginning of newStatusIds', () => {
      const store = useTimelinesStore();
      store.prependStatus('home', '1');
      store.prependStatus('home', '2');
      const timeline = store.getTimeline('home');
      expect(timeline.newStatusIds[0]).toBe('2');
      expect(timeline.newStatusIds[1]).toBe('1');
    });
  });

  describe('showNewStatuses', () => {
    it('moves newStatusIds into statusIds', () => {
      const store = useTimelinesStore();
      const timeline = store.getTimeline('home');
      timeline.statusIds = ['old-1', 'old-2'];
      store.prependStatus('home', 'new-1');
      store.prependStatus('home', 'new-2');
      store.showNewStatuses('home');
      expect(timeline.statusIds[0]).toBe('new-2');
      expect(timeline.statusIds[1]).toBe('new-1');
      expect(timeline.statusIds[2]).toBe('old-1');
      expect(timeline.newStatusIds).toEqual([]);
    });
  });

  describe('removeStatus', () => {
    it('removes statusId from all timelines', () => {
      const store = useTimelinesStore();
      const home = store.getTimeline('home');
      const local = store.getTimeline('local');
      home.statusIds = ['1', '2', '3'];
      local.statusIds = ['2', '4'];
      store.removeStatus('2');
      expect(home.statusIds).toEqual(['1', '3']);
      expect(local.statusIds).toEqual(['4']);
    });

    it('also removes from newStatusIds', () => {
      const store = useTimelinesStore();
      store.prependStatus('home', '5');
      store.prependStatus('home', '6');
      store.removeStatus('5');
      const timeline = store.getTimeline('home');
      expect(timeline.newStatusIds).toEqual(['6']);
    });
  });
});
