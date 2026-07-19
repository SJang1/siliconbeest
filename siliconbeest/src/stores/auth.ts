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
import { resetStatusPagePrefetches } from '@/composables/useStatusPagePrefetch';
import { useTimelinesStore } from './timelines';
import { useNotificationsStore } from './notifications';
import { useUiStore } from './ui';
import {
  isRegistrationRequiredResponse,
  type RegistrationDesign,
  type RegistrationState,
} from '@/types/registration';

const TOKEN_KEY = 'siliconbeest_token';

export type AuthLoginResult =
  | { type: 'authenticated' }
  | { type: 'registration_required'; state: RegistrationState };

export type AuthRegisterResult =
  | { type: 'authenticated' }
  | { type: 'registration_required'; state: RegistrationState };

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
  let currentUserRequestGeneration = 0;

  const isAuthenticated = computed(() => !!token.value);
  const isAdmin = computed(() => currentUser.value?.role?.name === 'admin');
  const isModerator = computed(
    () =>
      currentUser.value?.role?.name === 'moderator' ||
      currentUser.value?.role?.name === 'admin',
  );

  function resetPerAccountState(newToken: string | null) {
    currentUserRequestGeneration += 1;
    token.value = newToken;
    currentUser.value = null;
    loading.value = false;
    error.value = null;
    useUiStore().resetToDefaults();
    // Timelines and their opaque recommendation cursors belong to the account
    // that requested them. Reset also invalidates in-flight responses and
    // disconnects old-token streams before the next account can reuse them.
    useTimelinesStore().reset();
    // Notifications and their prefetched raw page are account-scoped too.
    useNotificationsStore().reset();
    resetStatusPagePrefetches();
  }

  function setToken(newToken: string) {
    if (token.value !== newToken) {
      resetPerAccountState(newToken);
    }
    writeTokenCookie(newToken);
  }

  function syncTokenFromCookie(cookieToken?: string | null) {
    const storedToken = cookieToken !== undefined ? cookieToken : readTokenCookie();

    if (!storedToken) {
      if (token.value !== null) {
        resetPerAccountState(null);
      }
      return null;
    }

    if (token.value !== storedToken) {
      resetPerAccountState(storedToken);
    }

    return token.value;
  }

  function setReady(value: boolean) {
    ready.value = value;
  }

  function clearToken() {
    resetPerAccountState(null);
    clearTokenCookie();
  }

  function connectAuthenticatedNotificationStream(
    streamToken: string | null = token.value,
  ) {
    if (typeof window === 'undefined' || !streamToken) return;

    const notificationsStore = useNotificationsStore();
    notificationsStore.connectStream(streamToken);
  }

  async function fetchCurrentUser() {
    syncTokenFromCookie();
    const requestToken = token.value;
    if (!requestToken) return;
    const requestGeneration = ++currentUserRequestGeneration;
    loading.value = true;
    error.value = null;
    try {
      const { data } = await verifyCredentials(requestToken);
      if (
        token.value !== requestToken ||
        currentUserRequestGeneration !== requestGeneration
      ) return;

      currentUser.value = data;
      // Load server-synced UI preferences
      const uiStore = useUiStore();
      await uiStore.loadFromServer(requestToken);
      if (
        token.value !== requestToken ||
        currentUserRequestGeneration !== requestGeneration
      ) return;
      // Timeline views connect their own streams when they are mounted. Keep
      // only notifications global so an empty desktop deck loads no timeline.
      connectAuthenticatedNotificationStream(requestToken);
    } catch (e) {
      if (
        token.value !== requestToken ||
        currentUserRequestGeneration !== requestGeneration
      ) return;

      error.value = (e as Error).message;
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        clearToken();
      }
    } finally {
      if (
        token.value === requestToken &&
        currentUserRequestGeneration === requestGeneration
      ) {
        loading.value = false;
      }
    }
  }

  async function login(
    username: string,
    password: string,
  ): Promise<AuthLoginResult> {
    loading.value = true;
    error.value = null;
    try {
      const { data } = await apiLogin(username, password);
      if (isRegistrationRequiredResponse(data)) {
        clearToken();
        return { type: 'registration_required', state: data.registration_state };
      }
      setToken(data.access_token);
      await fetchCurrentUser();
      return { type: 'authenticated' };
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
    invite_token?: string;
    redirect_uri?: string;
    design?: RegistrationDesign;
  }): Promise<AuthRegisterResult> {
    loading.value = true;
    error.value = null;
    try {
      const { data } = await apiRegister(params);
      if (isRegistrationRequiredResponse(data)) {
        clearToken();
        return { type: 'registration_required', state: data.registration_state };
      }
      setToken(data.access_token);
      await fetchCurrentUser();
      return { type: 'authenticated' };
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
  setOnUnauthorized((requestToken) => {
    // A response from the previous account must not log out the account that
    // has since become active. A missing token preserves legacy callback use.
    if (requestToken && requestToken !== token.value) return;

    clearToken();
    // Redirect to login if not already there
    if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
      window.location.href = '/login';
    }
  });

  async function logout() {
    const tokenToRevoke = token.value ?? readTokenCookie();

    // Clear local state first so route guards and UI stop treating the user as logged in.
    clearToken();

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
