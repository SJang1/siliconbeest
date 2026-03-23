import { apiFetch, apiFetchFormData, buildQueryString } from '../client';
import type {
  Account,
  CredentialAccount,
  Relationship,
  Status,
  PaginationOpts,
} from '@/types/mastodon';

export function getAccount(id: string, token?: string) {
  return apiFetch<Account>(`/v1/accounts/${id}`, { token });
}

export function verifyCredentials(token: string) {
  return apiFetch<CredentialAccount>('/v1/accounts/verify_credentials', { token });
}

export function updateCredentials(token: string, data: FormData) {
  return apiFetchFormData<CredentialAccount>('/v1/accounts/update_credentials', data, {
    token,
    method: 'PATCH',
  });
}

export function followAccount(id: string, token: string) {
  return apiFetch<Relationship>(`/v1/accounts/${id}/follow`, {
    method: 'POST',
    token,
  });
}

export function unfollowAccount(id: string, token: string) {
  return apiFetch<Relationship>(`/v1/accounts/${id}/unfollow`, {
    method: 'POST',
    token,
  });
}

export function blockAccount(id: string, token: string) {
  return apiFetch<Relationship>(`/v1/accounts/${id}/block`, {
    method: 'POST',
    token,
  });
}

export function unblockAccount(id: string, token: string) {
  return apiFetch<Relationship>(`/v1/accounts/${id}/unblock`, {
    method: 'POST',
    token,
  });
}

export function muteAccount(id: string, token: string) {
  return apiFetch<Relationship>(`/v1/accounts/${id}/mute`, {
    method: 'POST',
    token,
  });
}

export function unmuteAccount(id: string, token: string) {
  return apiFetch<Relationship>(`/v1/accounts/${id}/unmute`, {
    method: 'POST',
    token,
  });
}

export function getRelationships(ids: string[], token: string) {
  const qs = buildQueryString({ id: ids });
  return apiFetch<Relationship[]>(`/v1/accounts/relationships${qs}`, { token });
}

export function searchAccounts(q: string, opts?: { limit?: number; token?: string }) {
  const qs = buildQueryString({ q, limit: opts?.limit });
  return apiFetch<Account[]>(`/v1/accounts/search${qs}`, { token: opts?.token });
}

export function getFollowers(id: string, opts?: PaginationOpts) {
  const qs = buildQueryString({
    max_id: opts?.max_id,
    since_id: opts?.since_id,
    limit: opts?.limit,
  });
  return apiFetch<Account[]>(`/v1/accounts/${id}/followers${qs}`, { token: opts?.token });
}

export function getFollowing(id: string, opts?: PaginationOpts) {
  const qs = buildQueryString({
    max_id: opts?.max_id,
    since_id: opts?.since_id,
    limit: opts?.limit,
  });
  return apiFetch<Account[]>(`/v1/accounts/${id}/following${qs}`, { token: opts?.token });
}

export function getAccountStatuses(
  id: string,
  opts?: PaginationOpts & {
    only_media?: boolean;
    exclude_replies?: boolean;
    exclude_reblogs?: boolean;
    pinned?: boolean;
    tagged?: string;
  },
) {
  const qs = buildQueryString({
    max_id: opts?.max_id,
    since_id: opts?.since_id,
    min_id: opts?.min_id,
    limit: opts?.limit,
    only_media: opts?.only_media,
    exclude_replies: opts?.exclude_replies,
    exclude_reblogs: opts?.exclude_reblogs,
    pinned: opts?.pinned,
    tagged: opts?.tagged,
  });
  return apiFetch<Status[]>(`/v1/accounts/${id}/statuses${qs}`, { token: opts?.token });
}

export function lookupAccount(acct: string, token?: string) {
  const qs = buildQueryString({ acct });
  return apiFetch<Account>(`/v1/accounts/lookup${qs}`, { token });
}
