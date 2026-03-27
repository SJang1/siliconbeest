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
  return apiFetch<void>('/v1/admin/email/test', {
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

export interface FederationInstance {
  domain: string;
  software: string | null;
  version: string | null;
  description: string | null;
  account_count: number;
  failure_count: number;
  last_successful_at: string | null;
  open_registrations: boolean | null;
  created_at: string;
}

export interface FederationStats {
  total: number;
  active: number;
  unreachable: number;
  remote_accounts: number;
}

export function getFederationInstances(token: string, params?: Record<string, string>) {
  const qs = params ? buildQueryString(params) : '';
  return apiFetch<FederationInstance[]>(`/v1/admin/federation/instances${qs}`, { token });
}

export function getFederationInstance(token: string, domain: string) {
  return apiFetch<FederationInstance>(`/v1/admin/federation/instances/${encodeURIComponent(domain)}`, { token });
}

export function getFederationStats(token: string) {
  return apiFetch<FederationStats>('/v1/admin/federation/stats', { token });
}
