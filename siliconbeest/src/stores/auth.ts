import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { CredentialAccount, Token } from '@/types/mastodon';
import { verifyCredentials } from '@/api/mastodon/accounts';
import { login as apiLogin, register as apiRegister, revokeToken } from '@/api/mastodon/oauth';
import { ApiError } from '@/api/client';
import {
  getAuthenticateOptions,
  verifyAuthentication,
  base64urlEncode,
  base64urlDecode,
} from '@/api/mastodon/webauthn';
import { setOnUnauthorized } from '@/api/client';
import { useTimelinesStore } from './timelines';
import { useNotificationsStore } from './notifications';
import { useUiStore } from './ui';

const TOKEN_KEY = 'siliconbeest_token';

function readTokenCookie(): string | null {
  if (typeof document === 'undefined') return null;

  for (const part of document.cookie.split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=');
    if (rawKey === TOKEN_KEY) {
      return decodeURIComponent(rawValue.join('='));
    }
  }

  return null;
}

function writeTokenCookie(newToken: string) {
  if (typeof document === 'undefined') return;

  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${TOKEN_KEY}=${encodeURIComponent(newToken)}; Path=/; Max-Age=${60 * 60 * 24 * 30}; SameSite=Lax${secure}`;
}

function clearTokenCookie() {
  if (typeof document === 'undefined') return;

  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${TOKEN_KEY}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax${secure}`;
}

export const useAuthStore = defineStore('auth', () => {
  const token = ref<string | null>(
    readTokenCookie(),
  );
  const currentUser = ref<CredentialAccount | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const ready = ref(false);

  const isAuthenticated = computed(() => !!token.value);
  const isAdmin = computed(() => currentUser.value?.role?.name === 'admin');
  const isModerator = computed(
    () =>
      currentUser.value?.role?.name === 'moderator' ||
      currentUser.value?.role?.name === 'admin',
  );

  function setToken(newToken: string) {
    token.value = newToken;
    writeTokenCookie(newToken);
  }

  function syncTokenFromCookie(cookieToken?: string | null) {
    const storedToken = cookieToken !== undefined ? cookieToken : readTokenCookie();

    if (!storedToken) {
      token.value = null;
      currentUser.value = null;
      return null;
    }

    if (token.value !== storedToken) {
      token.value = storedToken;
      currentUser.value = null;
    }

    return token.value;
  }

  function setReady(value: boolean) {
    ready.value = value;
  }

  function clearToken() {
    token.value = null;
    currentUser.value = null;
    clearTokenCookie();
  }

  async function fetchCurrentUser() {
    syncTokenFromCookie();
    if (!token.value) return;
    loading.value = true;
    error.value = null;
    try {
      const { data } = await verifyCredentials(token.value);
      currentUser.value = data;
      // Load server-synced UI preferences
      const uiStore = useUiStore();
      uiStore.loadFromServer(token.value);
    } catch (e) {
      error.value = (e as Error).message;
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        clearToken();
      }
    } finally {
      loading.value = false;
    }
  }

  async function login(username: string, password: string, turnstile_token?: string) {
    loading.value = true;
    error.value = null;
    try {
      const { data } = await apiLogin(username, password, turnstile_token);
      setToken(data.access_token);
      await fetchCurrentUser();
    } catch (e) {
      error.value = (e as Error).message;
      throw e;
    } finally {
      loading.value = false;
    }
  }

  async function register(params: {
    username: string;
    email: string;
    password: string;
    agreement?: boolean;
    locale?: string;
    reason?: string;
    turnstile_token?: string;
  }): Promise<{ confirmationRequired: boolean }> {
    loading.value = true;
    error.value = null;
    try {
      const { data } = await apiRegister(params);
      if (data.confirmation_required) {
        return { confirmationRequired: true };
      }
      if (data.access_token) {
        setToken(data.access_token);
        await fetchCurrentUser();
      }
      return { confirmationRequired: false };
    } catch (e) {
      error.value = (e as Error).message;
      throw e;
    } finally {
      loading.value = false;
    }
  }

  async function loginWithPasskey() {
    loading.value = true;
    error.value = null;
    try {
      // 1. Get authentication options from server
      const { data: options } = await getAuthenticateOptions();

      // 2. Build publicKey options with ArrayBuffers
      const publicKeyOptions: PublicKeyCredentialRequestOptions = {
        challenge: base64urlDecode(options.challenge),
        timeout: options.timeout,
        rpId: options.rpId,
        allowCredentials: options.allowCredentials?.map((c) => ({
          id: base64urlDecode(c.id),
          type: c.type as PublicKeyCredentialType,
          transports: c.transports as AuthenticatorTransport[] | undefined,
        })),
        userVerification: (options.userVerification as UserVerificationRequirement) || 'preferred',
      };

      // 3. Get credential via browser API
      const credential = (await navigator.credentials.get({
        publicKey: publicKeyOptions,
      })) as PublicKeyCredential | null;

      if (!credential) {
        const err = new Error('Passkey operation was cancelled');
        err.name = 'NotAllowedError';
        throw err;
      }

      const response = credential.response as AuthenticatorAssertionResponse;

      // 4. Serialize credential for the server
      const serialized = {
        id: credential.id,
        rawId: base64urlEncode(credential.rawId),
        type: credential.type,
        response: {
          authenticatorData: base64urlEncode(response.authenticatorData),
          clientDataJSON: base64urlEncode(response.clientDataJSON),
          signature: base64urlEncode(response.signature),
          userHandle: response.userHandle ? base64urlEncode(response.userHandle) : null,
        },
      };

      // 5. Verify with server
      const { data } = await verifyAuthentication(serialized);
      setToken(data.access_token);
      await fetchCurrentUser();
    } catch (e) {
      error.value = (e as Error).message;
      throw e;
    } finally {
      loading.value = false;
    }
  }

  // Register global 401 handler — auto-logout when session is expired/revoked
  setOnUnauthorized(() => {
    clearToken();
    const timelinesStore = useTimelinesStore();
    const notificationsStore = useNotificationsStore();
    timelinesStore.disconnectStream();
    notificationsStore.disconnectStream();
    // Redirect to login if not already there
    if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
      window.location.href = '/login';
    }
  });

  async function logout() {
    const tokenToRevoke = token.value ?? readTokenCookie();

    // Clear local state first so route guards and UI stop treating the user as logged in.
    clearToken();

    const timelinesStore = useTimelinesStore();
    const notificationsStore = useNotificationsStore();
    timelinesStore.disconnectStream();
    notificationsStore.disconnectStream();

    const uiStore = useUiStore();
    uiStore.resetToDefaults();

    if (tokenToRevoke) {
      revokeToken({ token: tokenToRevoke }).catch(() => {
        // Server might be unreachable; local logout has already completed.
      });
    }
  }

  return {
    token,
    currentUser,
    loading,
    error,
    isAuthenticated,
    isAdmin,
    isModerator,
    ready,
    setToken,
    syncTokenFromCookie,
    setReady,
    clearToken,
    fetchCurrentUser,
    login,
    loginWithPasskey,
    register,
    logout,
  };
});
