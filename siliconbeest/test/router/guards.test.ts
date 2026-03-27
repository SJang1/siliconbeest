import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useAuthStore } from '@/stores/auth';
import { requireAuth, requireAdmin, redirectIfAuthenticated } from '@/router/guards';

describe('Router Guards', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.removeItem("siliconbeest_token"); localStorage.removeItem("siliconbeest_theme");
  });

  async function callGuard(guard: any, to: any = { fullPath: '/test' }, from: any = {}) {
    const next = vi.fn();
    await guard(to, from, next);
    return next;
  }

  describe('requireAuth', () => {
    it('redirects to login when not authenticated', async () => {
      const next = await callGuard(requireAuth, { fullPath: '/notifications' });
      expect(next).toHaveBeenCalledWith({
        name: 'login',
        query: { redirect: '/notifications' },
      });
    });

    it('allows navigation when authenticated', async () => {
      const store = useAuthStore();
      store.setToken('valid-token');
      const next = await callGuard(requireAuth);
      expect(next).toHaveBeenCalledWith();
    });

    it('passes redirect path in query', async () => {
      const next = await callGuard(requireAuth, { fullPath: '/settings/profile' });
      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({
          query: { redirect: '/settings/profile' },
        }),
      );
    });
  });

  describe('requireAdmin', () => {
    it('redirects to login when not authenticated', async () => {
      const next = await callGuard(requireAdmin);
      expect(next).toHaveBeenCalledWith({ name: 'login' });
    });

    it('redirects to home when authenticated but not admin', async () => {
      const store = useAuthStore();
      store.setToken('user-token');
      // currentUser has no admin role
      store.currentUser = { id: '1', role: { name: 'user' } } as any;
      const next = await callGuard(requireAdmin);
      expect(next).toHaveBeenCalledWith({ name: 'home' });
    });

    it('allows navigation when admin', async () => {
      const store = useAuthStore();
      store.setToken('admin-token');
      store.currentUser = { id: '1', role: { name: 'admin' } } as any;
      const next = await callGuard(requireAdmin);
      expect(next).toHaveBeenCalledWith();
    });
  });

  describe('redirectIfAuthenticated', () => {
    it('allows navigation when not authenticated', async () => {
      const next = await callGuard(redirectIfAuthenticated);
      expect(next).toHaveBeenCalledWith();
    });

    it('redirects to home when authenticated', async () => {
      const store = useAuthStore();
      store.setToken('some-token');
      const next = await callGuard(redirectIfAuthenticated);
      expect(next).toHaveBeenCalledWith({ name: 'home' });
    });
  });
});
