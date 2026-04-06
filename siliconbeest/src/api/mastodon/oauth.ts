import { apiFetch } from '../client';
import type { OAuthApp, Token } from '@/types/mastodon';

export function createApp(params: {
  client_name: string;
  redirect_uris: string;
  scopes: string;
  website?: string;
}) {
  return apiFetch<OAuthApp>('/v1/apps', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export function getToken(params: {
  grant_type: string;
  client_id: string;
  client_secret: string;
  redirect_uri: string;
  code?: string;
  scope?: string;
  username?: string;
  password?: string;
}) {
  // OAuth token endpoint is outside /api
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  return apiFetch<Token>('/../oauth/token', {
    method: 'POST',
    body: JSON.stringify(params),
    headers,
  });
}

export function revokeToken(params: {
  token: string;
  client_id?: string;
  client_secret?: string;
}) {
  // Server-side revoke only needs the token — client_id/secret are optional
  const formData = new URLSearchParams();
  formData.set('token', params.token);
  if (params.client_id) formData.set('client_id', params.client_id);
  if (params.client_secret) formData.set('client_secret', params.client_secret);
  return apiFetch<Record<string, never>>('/../oauth/revoke', {
    method: 'POST',
    body: formData.toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
}

// Direct login endpoint (non-standard, for the built-in frontend)
export function login(username: string, password: string, turnstile_token?: string) {
  return apiFetch<Token>('/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password, turnstile_token }),
  });
}

// Find username by email
export function findUsername(email: string) {
  return apiFetch<{ message: string }>('/v1/auth/find_username', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

export interface RegisterResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  created_at?: number;
  confirmation_required?: boolean;
}

export function register(params: {
  username: string;
  email: string;
  password: string;
  agreement?: boolean;
  locale?: string;
  reason?: string;
  turnstile_token?: string;
}) {
  return apiFetch<RegisterResponse>('/v1/accounts', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}
