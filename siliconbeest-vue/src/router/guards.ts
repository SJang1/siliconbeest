import type { NavigationGuardWithThis } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

/**
 * Navigation guard that requires the user to be authenticated.
 * Redirects to /login if not authenticated.
 */
export const requireAuth: NavigationGuardWithThis<undefined> = (to, _from, next) => {
  const auth = useAuthStore();
  if (!auth.isAuthenticated) {
    next({ name: 'login', query: { redirect: to.fullPath } });
  } else {
    next();
  }
};

/**
 * Navigation guard that requires the user to be an admin.
 * Redirects to home if not admin.
 */
export const requireAdmin: NavigationGuardWithThis<undefined> = (_to, _from, next) => {
  const auth = useAuthStore();
  if (!auth.isAuthenticated) {
    next({ name: 'login' });
  } else if (!auth.isAdmin) {
    next({ name: 'home' });
  } else {
    next();
  }
};

/**
 * Navigation guard that redirects authenticated users away from auth pages.
 * E.g., login page should redirect to home if already logged in.
 */
export const redirectIfAuthenticated: NavigationGuardWithThis<undefined> = (
  _to,
  _from,
  next,
) => {
  const auth = useAuthStore();
  if (auth.isAuthenticated) {
    next({ name: 'home' });
  } else {
    next();
  }
};
