import { apiFetch } from '../client';
import type { Status, Context } from '@/types/mastodon';

export interface CreateStatusParams {
  status?: string;
  media_ids?: string[];
  poll?: {
    options: string[];
    expires_in: number;
    multiple?: boolean;
    hide_totals?: boolean;
  };
  in_reply_to_id?: string;
  sensitive?: boolean;
  spoiler_text?: string;
  visibility?: 'public' | 'unlisted' | 'private' | 'direct';
  language?: string;
  scheduled_at?: string;
}

export function getStatus(id: string, token?: string) {
  return apiFetch<Status>(`/v1/statuses/${id}`, { token });
}

export function getStatusContext(id: string, token?: string) {
  return apiFetch<Context>(`/v1/statuses/${id}/context`, { token });
}

export function createStatus(params: CreateStatusParams, token: string) {
  return apiFetch<Status>('/v1/statuses', {
    method: 'POST',
    token,
    body: JSON.stringify(params),
  });
}

export function editStatus(id: string, params: CreateStatusParams, token: string) {
  return apiFetch<Status>(`/v1/statuses/${id}`, {
    method: 'PUT',
    token,
    body: JSON.stringify(params),
  });
}

export function deleteStatus(id: string, token: string) {
  return apiFetch<Status>(`/v1/statuses/${id}`, {
    method: 'DELETE',
    token,
  });
}

export function favouriteStatus(id: string, token: string) {
  return apiFetch<Status>(`/v1/statuses/${id}/favourite`, {
    method: 'POST',
    token,
  });
}

export function unfavouriteStatus(id: string, token: string) {
  return apiFetch<Status>(`/v1/statuses/${id}/unfavourite`, {
    method: 'POST',
    token,
  });
}

export function reblogStatus(id: string, token: string) {
  return apiFetch<Status>(`/v1/statuses/${id}/reblog`, {
    method: 'POST',
    token,
  });
}

export function unreblogStatus(id: string, token: string) {
  return apiFetch<Status>(`/v1/statuses/${id}/unreblog`, {
    method: 'POST',
    token,
  });
}

export function bookmarkStatus(id: string, token: string) {
  return apiFetch<Status>(`/v1/statuses/${id}/bookmark`, {
    method: 'POST',
    token,
  });
}

export function unbookmarkStatus(id: string, token: string) {
  return apiFetch<Status>(`/v1/statuses/${id}/unbookmark`, {
    method: 'POST',
    token,
  });
}

export function pinStatus(id: string, token: string) {
  return apiFetch<Status>(`/v1/statuses/${id}/pin`, {
    method: 'POST',
    token,
  });
}

export function unpinStatus(id: string, token: string) {
  return apiFetch<Status>(`/v1/statuses/${id}/unpin`, {
    method: 'POST',
    token,
  });
}

export function muteStatus(id: string, token: string) {
  return apiFetch<Status>(`/v1/statuses/${id}/mute`, {
    method: 'POST',
    token,
  });
}

export function unmuteStatus(id: string, token: string) {
  return apiFetch<Status>(`/v1/statuses/${id}/unmute`, {
    method: 'POST',
    token,
  });
}

export function getFavouritedBy(id: string, token?: string) {
  return apiFetch<import('@/types/mastodon').Account[]>(
    `/v1/statuses/${id}/favourited_by`,
    { token },
  );
}

export function getRebloggedBy(id: string, token?: string) {
  return apiFetch<import('@/types/mastodon').Account[]>(
    `/v1/statuses/${id}/reblogged_by`,
    { token },
  );
}
