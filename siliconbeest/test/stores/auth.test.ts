import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useAuthStore } from '@/stores/auth';

// Mock fetch for API calls
global.fetch = vi.fn();

describe('Auth Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.removeItem("siliconbeest_token"); localStorage.removeItem("siliconbeest_theme");
    vi.clearAllMocks();
  });

  it('initializes with no user', () => {
    const store = useAuthStore();
    expect(store.isAuthenticated).toBe(false);
    expect(store.currentUser).toBeNull();
    expect(store.token).toBeNull();
  });

  it('persists token to localStorage', () => {
    const store = useAuthStore();
    store.setToken('test-token-123');
    expect(localStorage.getItem('siliconbeest_token')).toBe('test-token-123');
  });

  it('restores token from localStorage', () => {
    localStorage.setItem('siliconbeest_token', 'saved-token');
    const store = useAuthStore();
    // Token should be restored on init
    expect(store.token).toBe('saved-token');
  });

  it('reports isAuthenticated when token present', () => {
    localStorage.setItem('siliconbeest_token', 'saved-token');
    const store = useAuthStore();
    expect(store.isAuthenticated).toBe(true);
  });

  it('clears state on logout', async () => {
    const store = useAuthStore();
    store.setToken('test-token');
    await store.logout();
    expect(store.token).toBeNull();
    expect(store.isAuthenticated).toBe(false);
    expect(localStorage.getItem('siliconbeest_token')).toBeNull();
  });

  it('clearToken also nulls currentUser', () => {
    const store = useAuthStore();
    store.setToken('test-token');
    // manually set currentUser to something
    store.currentUser = { id: '1', username: 'test' } as any;
    store.clearToken();
    expect(store.currentUser).toBeNull();
  });

  it('isAdmin is false when no user', () => {
    const store = useAuthStore();
    expect(store.isAdmin).toBe(false);
  });

  it('isModerator is false when no user', () => {
    const store = useAuthStore();
    expect(store.isModerator).toBe(false);
  });
});
