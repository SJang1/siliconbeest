import { apiFetch, buildQueryString } from '../client';
import type { SearchResults } from '@/types/mastodon';

export function search(
  q: string,
  opts?: {
    type?: 'accounts' | 'hashtags' | 'statuses';
    resolve?: boolean;
    following?: boolean;
    account_id?: string;
    offset?: number;
    limit?: number;
    token?: string;
  },
) {
  const qs = buildQueryString({
    q,
    type: opts?.type,
    resolve: opts?.resolve,
    following: opts?.following,
    account_id: opts?.account_id,
    offset: opts?.offset,
    limit: opts?.limit,
  });
  return apiFetch<SearchResults>(`/v2/search${qs}`, { token: opts?.token });
}
