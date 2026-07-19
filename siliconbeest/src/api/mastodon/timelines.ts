import { apiFetch, buildQueryString } from '../client';
import type { Status, PaginationOpts } from '@/types/mastodon';

type TimelineRequestOpts = PaginationOpts & { signal?: AbortSignal };

export function getHomeTimeline(opts: TimelineRequestOpts & { token: string }) {
  const qs = buildQueryString({
    max_id: opts.max_id,
    since_id: opts.since_id,
    min_id: opts.min_id,
    limit: opts.limit,
  });
  return apiFetch<Status[]>(`/v1/timelines/home${qs}`, {
    token: opts.token,
    signal: opts.signal,
  });
}

export function getSocialTimeline(opts: TimelineRequestOpts & { token: string }) {
  const qs = buildQueryString({
    max_id: opts.max_id,
    since_id: opts.since_id,
    min_id: opts.min_id,
    limit: opts.limit,
  });
  return apiFetch<Status[]>(`/v1/timelines/social${qs}`, {
    token: opts.token,
    signal: opts.signal,
  });
}

export function getRecommendedTimeline(
  opts: TimelineRequestOpts & { token: string },
) {
  const qs = buildQueryString({
    limit: opts.limit,
  });
  return apiFetch<Status[]>(`/v1/timelines/recommended${qs}`, {
    method: 'POST',
    token: opts.token,
    signal: opts.signal,
  });
}

/** Follow the opaque cursor URL returned by the recommended timeline Link header. */
export function getRecommendedTimelinePage(
  nextPath: string,
  token: string,
  signal?: AbortSignal,
) {
  const path = nextPath.startsWith('/api/') ? nextPath.slice('/api'.length) : nextPath;
  if (!path.startsWith('/v1/timelines/recommended?')) {
    throw new Error('Invalid recommended timeline page');
  }
  return apiFetch<Status[]>(path, { method: 'POST', token, signal });
}

export function getPublicTimeline(
  opts?: TimelineRequestOpts & { local?: boolean; remote?: boolean; only_media?: boolean },
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
  return apiFetch<Status[]>(`/v1/timelines/public${qs}`, {
    token: opts?.token,
    signal: opts?.signal,
  });
}

export function getTagTimeline(
  tag: string,
  opts?: TimelineRequestOpts & { local?: boolean; only_media?: boolean },
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
    signal: opts?.signal,
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
