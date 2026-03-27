import { apiFetch, buildQueryString } from '../client';
import type { Status } from '@/types/mastodon';

export function getBookmarks(token: string, params?: { max_id?: string; limit?: number }) {
  const qs = buildQueryString({
    max_id: params?.max_id,
    limit: params?.limit,
  });
  return apiFetch<Status[]>(`/v1/bookmarks${qs}`, { token });
}
