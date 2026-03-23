import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useAuthStore } from '@/stores/auth';
import { requireAuth, requireAdmin, redirectIfAuthenticated } from '@/router/guards';

describe('Router Guards', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.removeItem("siliconbeest_token"); localStorage.removeItem("siliconbeest_theme");
  });

  function callGuard(guard: any, to: any = { fullPath: '/test' }, from: any = {}) {
    const next = vi.fn();
    guard(to, from, next);
    return next;
  }

  describe('requireAuth', () => {
    it('redirects to login when not authenticated', () => {
      const next = callGuard(requireAuth, { fullPath: '/notifications' });
      expect(next).toHaveBeenCalledWith({
        name: 'login',
        query: { redirect: '/notifications' },
      });
    });

    it('allows navigation when authenticated', () => {
      const store = useAuthStore();
      store.setToken('valid-token');
      const next = callGuard(requireAuth);
      expect(next).toHaveBeenCalledWith();
    });

    it('passes redirect path in query', () => {
      const next = callGuard(requireAuth, { fullPath: '/settings/profile' });
      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({
          query: { redirect: '/settings/profile' },
        }),
      );
    });
  });

  describe('requireAdmin', () => {
    it('redirects to login when not authenticated', () => {
      const next = callGuard(requireAdmin);
      expect(next).toHaveBeenCalledWith({ name: 'login' });
    });

    it('redirects to home when authenticated but not admin', () => {
      const store = useAuthStore();
      store.setToken('user-token');
      // currentUser has no admin role
      store.currentUser = { id: '1', role: { name: 'user' } } as any;
      const next = callGuard(requireAdmin);
      expect(next).toHaveBeenCalledWith({ name: 'home' });
    });

    it('allows navigation when admin', () => {
      const store = useAuthStore();
      store.setToken('admin-token');
      store.currentUser = { id: '1', role: { name: 'admin' } } as any;
      const next = callGuard(requireAdmin);
      expect(next).toHaveBeenCalledWith();
    });
  });

  describe('redirectIfAuthenticated', () => {
    it('allows navigation when not authenticated', () => {
      const next = callGuard(redirectIfAuthenticated);
      expect(next).toHaveBeenCalledWith();
    });

    it('redirects to home when authenticated', () => {
      const store = useAuthStore();
      store.setToken('some-token');
      const next = callGuard(redirectIfAuthenticated);
      expect(next).toHaveBeenCalledWith({ name: 'home' });
    });
  });
});
