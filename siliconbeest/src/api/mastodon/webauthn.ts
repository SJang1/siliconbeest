import { apiFetch } from '../client';

// Base64url encode/decode helpers for WebAuthn ArrayBuffer <-> string conversion

export function base64urlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlDecode(str: string): ArrayBuffer {
  // Add padding
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const padding = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  const binary = atob(padded + padding);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// Types

export interface WebAuthnCredential {
  id: string;
  credential_id: string;
  name: string;
  device_type: string;
  backed_up: boolean;
  created_at: string;
  last_used_at: string | null;
}

export interface RegisterOptionsResponse {
  rp: { name: string; id: string };
  user: { id: string; name: string; displayName: string };
  challenge: string;
  pubKeyCredParams: Array<{ type: string; alg: number }>;
  timeout?: number;
  excludeCredentials?: Array<{ id: string; type: string; transports?: string[] }>;
  authenticatorSelection?: {
    authenticatorAttachment?: string;
    requireResidentKey?: boolean;
    residentKey?: string;
    userVerification?: string;
  };
  attestation?: string;
}

export interface AuthenticateOptionsResponse {
  challenge: string;
  timeout?: number;
  rpId?: string;
  allowCredentials?: Array<{ id: string; type: string; transports?: string[] }>;
  userVerification?: string;
}

// API functions

export function getRegisterOptions(token: string) {
  return apiFetch<RegisterOptionsResponse>('/v1/auth/webauthn/register/options', {
    method: 'POST',
    token,
  });
}

export function verifyRegistration(token: string, credential: any, name?: string) {
  return apiFetch('/v1/auth/webauthn/register/verify', {
    method: 'POST',
    token,
    body: JSON.stringify({ ...credential, name }),
  });
}

export function getAuthenticateOptions(email?: string) {
  return apiFetch<AuthenticateOptionsResponse>('/v1/auth/webauthn/authenticate/options', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

export function verifyAuthentication(credential: any) {
  return apiFetch<{ access_token: string }>('/v1/auth/webauthn/authenticate/verify', {
    method: 'POST',
    body: JSON.stringify(credential),
  });
}

export function listCredentials(token: string) {
  return apiFetch<WebAuthnCredential[]>('/v1/auth/webauthn/credentials', { token });
}

export function deleteCredential(token: string, id: string) {
  return apiFetch(`/v1/auth/webauthn/credentials/${id}`, { method: 'DELETE', token });
}
