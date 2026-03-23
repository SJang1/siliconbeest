import { apiFetch, buildQueryString } from '../client';

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

export function changeRole(token: string, accountId: string, role: string) {
  return apiFetch<void>(`/v1/admin/accounts/${accountId}/role`, {
    method: 'POST',
    token,
    body: JSON.stringify({ role }),
  });
}

export function sendAdminEmail(token: string, to: string, subject: string, body: string) {
  return apiFetch<void>('/v1/admin/email', {
    method: 'POST',
    token,
    body: JSON.stringify({ to, subject, body }),
  });
}

export function testSmtp(token: string) {
  return apiFetch<void>('/v1/admin/settings/smtp_test', {
    method: 'POST',
    token,
  });
}

export function getAdminSettings(token: string) {
  return apiFetch<Record<string, string>>('/v1/admin/settings', { token });
}

export function updateAdminSettings(token: string, settings: Record<string, string>) {
  return apiFetch<Record<string, string>>('/v1/admin/settings', {
    method: 'PATCH',
    token,
    body: JSON.stringify(settings),
  });
}

export function getAdminAccounts(token: string, params?: Record<string, string>) {
  const qs = params ? buildQueryString(params) : '';
  return apiFetch<unknown[]>(`/v1/admin/accounts${qs}`, { token });
}
