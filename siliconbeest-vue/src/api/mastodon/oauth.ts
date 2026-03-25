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
  client_id: string;
  client_secret: string;
  token: string;
}) {
  return apiFetch<Record<string, never>>('/../oauth/revoke', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

// Direct login endpoint (non-standard, for the built-in frontend)
export function login(email: string, password: string) {
  return apiFetch<Token>('/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
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
}) {
  return apiFetch<RegisterResponse>('/v1/accounts', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}
