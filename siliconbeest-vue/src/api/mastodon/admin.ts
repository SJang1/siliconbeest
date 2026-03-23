import { apiFetch } from '../client';

export interface Relay {
  id: string;
  inbox_url: string;
  state: string;
  created_at: string;
}

export function getRelays(token: string) {
  return apiFetch<Relay[]>('/v1/admin/relays', { token });
}

export function addRelay(token: string, inboxUrl: string) {
  return apiFetch<Relay>('/v1/admin/relays', {
    method: 'POST',
    token,
    body: JSON.stringify({ inbox_url: inboxUrl }),
  });
}

export function removeRelay(token: string, id: string) {
  return apiFetch<void>(`/v1/admin/relays/${id}`, {
    method: 'DELETE',
    token,
  });
}
