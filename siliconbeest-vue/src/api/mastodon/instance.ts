import { apiFetch } from '../client';
import type { Instance, CustomEmoji, Announcement } from '@/types/mastodon';

export function getInstance() {
  return apiFetch<Instance>('/v2/instance');
}

export function getInstanceV1() {
  return apiFetch<Record<string, unknown>>('/v1/instance');
}

export function getCustomEmojis() {
  return apiFetch<CustomEmoji[]>('/v1/custom_emojis');
}

export function getAnnouncements(token?: string) {
  return apiFetch<Announcement[]>('/v1/announcements', { token });
}

export function dismissAnnouncement(id: string, token: string) {
  return apiFetch<Record<string, never>>(`/v1/announcements/${id}/dismiss`, {
    method: 'POST',
    token,
  });
}
