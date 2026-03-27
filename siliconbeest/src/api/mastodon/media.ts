import { apiFetchFormData, apiFetch } from '../client';
import type { MediaAttachment } from '@/types/mastodon';

export function uploadMedia(
  file: File,
  opts?: { description?: string; focus?: string; token: string },
) {
  const formData = new FormData();
  formData.append('file', file);
  if (opts?.description) formData.append('description', opts.description);
  if (opts?.focus) formData.append('focus', opts.focus);

  return apiFetchFormData<MediaAttachment>('/v2/media', formData, {
    token: opts?.token,
  });
}

export function updateMedia(
  id: string,
  data: { description?: string; focus?: string },
  token: string,
) {
  return apiFetch<MediaAttachment>(`/v1/media/${id}`, {
    method: 'PUT',
    token,
    body: JSON.stringify(data),
  });
}

export function getMedia(id: string, token: string) {
  return apiFetch<MediaAttachment>(`/v1/media/${id}`, { token });
}
