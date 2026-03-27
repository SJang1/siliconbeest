import { apiFetch, buildQueryString } from '../client';
import type { Notification, PaginationOpts } from '@/types/mastodon';

export function getNotifications(
  opts: PaginationOpts & {
    token: string;
    types?: string[];
    exclude_types?: string[];
    account_id?: string;
  },
) {
  const qs = buildQueryString({
    max_id: opts.max_id,
    since_id: opts.since_id,
    min_id: opts.min_id,
    limit: opts.limit,
    types: opts.types,
    exclude_types: opts.exclude_types,
    account_id: opts.account_id,
  });
  return apiFetch<Notification[]>(`/v1/notifications${qs}`, { token: opts.token });
}

export function getNotification(id: string, token: string) {
  return apiFetch<Notification>(`/v1/notifications/${id}`, { token });
}

export function clearNotifications(token: string) {
  return apiFetch<Record<string, never>>('/v1/notifications/clear', {
    method: 'POST',
    token,
  });
}

export function dismissNotification(id: string, token: string) {
  return apiFetch<Record<string, never>>(`/v1/notifications/${id}/dismiss`, {
    method: 'POST',
    token,
  });
}
