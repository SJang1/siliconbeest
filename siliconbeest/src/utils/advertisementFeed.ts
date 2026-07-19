import type { Status } from '@/types/mastodon';
import type { Advertisement, AdvertisementFeedItem } from '@/types/advertisement';

const FIRST_AD_MIN_INDEX = 9;
const FIRST_AD_JITTER = 4;
const NEXT_AD_MIN_GAP = 26;
const NEXT_AD_JITTER = 25;

/** Small deterministic hash: stable rendering without tracking a viewer. */
function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index++) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

/**
 * Add sparse advertisement slots to a feed. The first creative appears only
 * after 9–12 posts, then at 26–50-post gaps. Slots and creative rotation are
 * deterministic for the visible status IDs, so Vue updates do not flicker.
 */
export function mixAdvertisements(
  statuses: readonly Status[],
  advertisements: readonly Advertisement[],
  context: string,
): AdvertisementFeedItem[] {
  if (advertisements.length === 0 || statuses.length < FIRST_AD_MIN_INDEX) {
    return statuses.map((status) => ({
      kind: 'status' as const,
      key: `status:${status.id}`,
      status,
    }));
  }

  const result: AdvertisementFeedItem[] = [];
  const topId = statuses[0]?.id ?? 'empty';
  let nextSlot = FIRST_AD_MIN_INDEX + (hash(`${context}:${topId}:first`) % FIRST_AD_JITTER);
  let slot = 0;
  let previousAdvertisementIndex = -1;

  statuses.forEach((status, index) => {
    result.push({ kind: 'status', key: `status:${status.id}`, status });
    if (index + 1 !== nextSlot) return;

    let advertisementIndex = hash(`${context}:${status.id}:${slot}`) % advertisements.length;
    if (advertisements.length > 1 && advertisementIndex === previousAdvertisementIndex) {
      advertisementIndex = (advertisementIndex + 1) % advertisements.length;
    }
    const advertisement = advertisements[advertisementIndex];
    if (advertisement) {
      result.push({
        kind: 'advertisement',
        key: `advertisement:${slot}:${status.id}:${advertisement.id}`,
        advertisement,
      });
      previousAdvertisementIndex = advertisementIndex;
    }

    slot += 1;
    nextSlot += NEXT_AD_MIN_GAP
      + (hash(`${context}:${status.id}:${slot}:gap`) % NEXT_AD_JITTER);
  });

  return result;
}
