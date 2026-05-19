import { useAuthStore } from '@/stores/auth';
import { watch } from 'vue';

const AUTH_ONLY_PREFIXES = [
  '/home',
  '/notifications',
  '/conversations',
  '/bookmarks',
  '/favourites',
  '/lists',
  '/follow-requests',
  '/followed_tags',
  '/settings',
];

const ADMIN_PREFIXES = ['/admin'];
const GUEST_ONLY_PATHS = new Set(['/', '/login', '/register']);

function isAuthOnly(path: string): boolean {
  return AUTH_ONLY_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function isAdminOnly(path: string): boolean {
  return ADMIN_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export default defineNuxtPlugin((nuxtApp) => {
  const router = useRouter();

  function enforceCurrentRoute() {
    const auth = useAuthStore();
    auth.syncTokenFromCookie();
    const currentRoute = router.currentRoute.value;
    const path = currentRoute.path;

    if ((isAuthOnly(path) || isAdminOnly(path)) && !auth.isAuthenticated) {
      router.replace({ path: '/login', query: { redirect: currentRoute.fullPath } });
    }
  }

  router.beforeEach(async (to) => {
    const auth = useAuthStore();
    auth.syncTokenFromCookie();

    if ((isAuthOnly(to.path) || isAdminOnly(to.path)) && !auth.isAuthenticated) {
      return { path: '/login', query: { redirect: to.fullPath } };
    }

    if (auth.isAuthenticated && !auth.currentUser) {
      void auth.fetchCurrentUser();
    }

    if (auth.isAuthenticated && auth.currentUser && GUEST_ONLY_PATHS.has(to.path)) {
      return '/home';
    }

    if (isAdminOnly(to.path)) {
      if (auth.isAuthenticated && !auth.currentUser) {
        await auth.fetchCurrentUser();
      }
      if (!auth.isAuthenticated) {
        return { path: '/login', query: { redirect: to.fullPath } };
      }
      if (!auth.isAdmin && !auth.isModerator) {
        return '/home';
      }
    }
  });

  nuxtApp.hook('app:mounted', () => {
    const auth = useAuthStore();
    if (auth.ready) {
      enforceCurrentRoute();
      return;
    }

    watch(
      () => auth.ready,
      (ready) => {
        if (ready) enforceCurrentRoute();
      },
      { once: true },
    );
  });
});
