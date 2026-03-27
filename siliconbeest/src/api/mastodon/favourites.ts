import { apiFetch, buildQueryString } from '../client';
import type { Status } from '@/types/mastodon';

export function getFavourites(token: string, params?: { max_id?: string; limit?: number }) {
  const qs = buildQueryString({
    max_id: params?.max_id,
    limit: params?.limit,
  });
  return apiFetch<Status[]>(`/v1/favourites${qs}`, { token });
}
