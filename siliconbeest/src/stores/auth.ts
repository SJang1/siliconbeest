import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { CredentialAccount, Token } from '@/types/mastodon';
import { verifyCredentials } from '@/api/mastodon/accounts';
import { login as apiLogin, register as apiRegister, revokeToken } from '@/api/mastodon/oauth';
import {
  getAuthenticateOptions,
  verifyAuthentication,
  base64urlEncode,
  base64urlDecode,
} from '@/api/mastodon/webauthn';
import { useTimelinesStore } from './timelines';
import { useNotificationsStore } from './notifications';

const TOKEN_KEY = 'siliconbeest_token';

export const useAuthStore = defineStore('auth', () => {
  const token = ref<string | null>(localStorage.getItem(TOKEN_KEY));
  const currentUser = ref<CredentialAccount | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  const isAuthenticated = computed(() => !!token.value);
  const isAdmin = computed(() => currentUser.value?.role?.name === 'admin');
  const isModerator = computed(
    () =>
      currentUser.value?.role?.name === 'moderator' ||
      currentUser.value?.role?.name === 'admin',
  );

  function setToken(newToken: string) {
    token.value = newToken;
    localStorage.setItem(TOKEN_KEY, newToken);
  }

  function clearToken() {
    token.value = null;
    currentUser.value = null;
    localStorage.removeItem(TOKEN_KEY);
  }

  async function fetchCurrentUser() {
    if (!token.value) return;
    loading.value = true;
    error.value = null;
    try {
      const { data } = await verifyCredentials(token.value);
      currentUser.value = data;
    } catch (e) {
      error.value = (e as Error).message;
      // Token might be expired
      clearToken();
    } finally {
      loading.value = false;
    }
  }

  async function login(email: string, password: string, turnstile_token?: string) {
    loading.value = true;
    error.value = null;
    try {
      const { data } = await apiLogin(email, password, turnstile_token);
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

  async function logout() {
    // 1. Revoke token on server (best-effort — don't block on failure)
    if (token.value) {
      try {
        await revokeToken({ token: token.value });
      } catch {
        // Server might be unreachable — still log out locally
      }
    }

    // 2. Disconnect all streaming connections
    const timelinesStore = useTimelinesStore();
    const notificationsStore = useNotificationsStore();
    timelinesStore.disconnectStream();
    notificationsStore.disconnectStream();

    // 3. Clear local state
    clearToken();
  }

  return {
    token,
    currentUser,
    loading,
    error,
    isAuthenticated,
    isAdmin,
    isModerator,
    setToken,
    clearToken,
    fetchCurrentUser,
    login,
    loginWithPasskey,
    register,
    logout,
  };
});
