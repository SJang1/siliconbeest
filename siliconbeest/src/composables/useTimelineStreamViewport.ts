import { onUnmounted, watch, type WatchSource } from 'vue';
import { useTimelinesStore, type TimelineType } from '@/stores/timelines';

/**
 * Switch a timeline WebSocket to count-only mode when every mounted view of
 * that stream has scrolled away from the newest edge.
 */
export function useTimelineStreamViewport(
  owner: string,
  type: WatchSource<TimelineType>,
  atTop: WatchSource<boolean>,
) {
  const timelinesStore = useTimelinesStore();
  const scopeKey = Symbol(owner);

  watch(
    [type, atTop],
    ([timelineType, isAtTop]) => {
      timelinesStore.setTimelineViewport(scopeKey, timelineType, isAtTop);
    },
    { immediate: true },
  );

  onUnmounted(() => timelinesStore.clearTimelineViewport(scopeKey));
}
