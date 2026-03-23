import { apiFetch, buildQueryString } from '../client';
import type { Status, PaginationOpts } from '@/types/mastodon';

export function getHomeTimeline(opts: PaginationOpts & { token: string }) {
  const qs = buildQueryString({
    max_id: opts.max_id,
    since_id: opts.since_id,
    min_id: opts.min_id,
    limit: opts.limit,
  });
  return apiFetch<Status[]>(`/v1/timelines/home${qs}`, { token: opts.token });
}

export function getPublicTimeline(
  opts?: PaginationOpts & { local?: boolean; remote?: boolean; only_media?: boolean },
) {
  const qs = buildQueryString({
    max_id: opts?.max_id,
    since_id: opts?.since_id,
    min_id: opts?.min_id,
    limit: opts?.limit,
    local: opts?.local,
    remote: opts?.remote,
    only_media: opts?.only_media,
  });
  return apiFetch<Status[]>(`/v1/timelines/public${qs}`, { token: opts?.token });
}

export function getTagTimeline(
  tag: string,
  opts?: PaginationOpts & { local?: boolean; only_media?: boolean },
) {
  const qs = buildQueryString({
    max_id: opts?.max_id,
    since_id: opts?.since_id,
    min_id: opts?.min_id,
    limit: opts?.limit,
    local: opts?.local,
    only_media: opts?.only_media,
  });
  return apiFetch<Status[]>(`/v1/timelines/tag/${encodeURIComponent(tag)}${qs}`, {
    token: opts?.token,
  });
}

export function getListTimeline(listId: string, opts: PaginationOpts & { token: string }) {
  const qs = buildQueryString({
    max_id: opts.max_id,
    since_id: opts.since_id,
    min_id: opts.min_id,
    limit: opts.limit,
  });
  return apiFetch<Status[]>(`/v1/timelines/list/${listId}${qs}`, { token: opts.token });
}
