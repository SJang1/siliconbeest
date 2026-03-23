import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { CredentialAccount, Token } from '@/types/mastodon';
import { verifyCredentials } from '@/api/mastodon/accounts';
import { login as apiLogin, register as apiRegister } from '@/api/mastodon/oauth';

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

  async function login(email: string, password: string) {
    loading.value = true;
    error.value = null;
    try {
      const { data } = await apiLogin(email, password);
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
    locale?: string;
    reason?: string;
  }) {
    loading.value = true;
    error.value = null;
    try {
      const { data } = await apiRegister(params);
      setToken(data.access_token);
      await fetchCurrentUser();
    } catch (e) {
      error.value = (e as Error).message;
      throw e;
    } finally {
      loading.value = false;
    }
  }

  function logout() {
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
    register,
    logout,
  };
});
