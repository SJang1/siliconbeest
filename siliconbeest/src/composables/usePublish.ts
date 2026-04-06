import { useAuthStore } from '@/stores/auth';
import { useComposeStore } from '@/stores/compose';
import { useStatusesStore } from '@/stores/statuses';
import { useTimelinesStore } from '@/stores/timelines';
import { useUiStore } from '@/stores/ui';
import type { StatusVisibility } from '@/types/mastodon';

export interface PublishPayload {
  content: string;
  visibility?: string;
  sensitive?: boolean;
  spoiler_text?: string;
  language?: string;
  in_reply_to_id?: string;
  media_ids?: string[];
}

/**
 * Centralized compose → publish helper.
 *
 * Applies the payload to the compose store, publishes, then distributes the
 * resulting status to caches and timelines.  When `in_reply_to_id` is set the
 * parent status's visibility is enforced as a ceiling (you can't post more
 * publicly than the parent).
 */
export function usePublish() {
  const auth = useAuthStore();
  const compose = useComposeStore();
  const statusesStore = useStatusesStore();
  const timelinesStore = useTimelinesStore();
  const ui = useUiStore();

  const VISIBILITY_RANK: Record<string, number> = {
    direct: 0,
    private: 1,
    unlisted: 2,
    public: 3,
  };

  /** Return the more restrictive of two visibility values. */
  function clampVisibility(requested: string, ceiling: string): string {
    const reqRank = VISIBILITY_RANK[requested] ?? 3;
    const ceilRank = VISIBILITY_RANK[ceiling] ?? 3;
    return reqRank <= ceilRank ? requested : ceiling;
  }

  async function publish(payload: PublishPayload) {
    if (!auth.token) return;

    compose.text = payload.content;

    // Determine visibility: if replying, clamp to parent visibility
    if (payload.in_reply_to_id) {
      const parent = statusesStore.getCached(payload.in_reply_to_id);
      const parentVisibility = parent?.visibility ?? 'public';
      const requested = payload.visibility ?? compose.defaultVisibility;
      compose.visibility = clampVisibility(requested, parentVisibility) as StatusVisibility;
    } else if (payload.visibility) {
      compose.visibility = payload.visibility as StatusVisibility;
    }

    if (payload.sensitive) compose.sensitive = payload.sensitive;
    if (payload.spoiler_text) {
      compose.contentWarning = payload.spoiler_text;
      compose.showContentWarning = true;
    }
    if (payload.language) compose.language = payload.language;
    if (payload.in_reply_to_id) compose.inReplyToId = payload.in_reply_to_id;
    if (payload.media_ids?.length) {
      // Media already uploaded — store IDs are set via the composer's own flow
    }

    const status = await compose.publish();
    if (status) {
      statusesStore.cacheStatus(status);
      timelinesStore.prependStatus('home', status.id);
      if (status.visibility === 'public') {
        timelinesStore.prependStatus('public', status.id);
        timelinesStore.prependStatus('local', status.id);
      }
      ui.closeComposeModal();
    }
    return status;
  }

  return { publish };
}
