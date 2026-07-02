import { useAuthStore } from '@/stores/auth';
import { watch } from 'vue';
import { isOldDesignPath, stripOldPrefix } from '@/utils/designVersion';

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
    // /old/* mirrors the canonical routes with the classic design.
    const old = isOldDesignPath(currentRoute.path);
    const path = stripOldPrefix(currentRoute.path);

    if ((isAuthOnly(path) || isAdminOnly(path)) && !auth.isAuthenticated) {
      router.replace({ path: old ? '/old/login' : '/login', query: { redirect: currentRoute.fullPath } });
      return;
    }

    if (auth.isAuthenticated && GUEST_ONLY_PATHS.has(path)) {
      router.replace(old ? '/old/home' : '/home');
    }
  }

  router.beforeEach(async (to) => {
    const auth = useAuthStore();
    auth.syncTokenFromCookie();

    const old = isOldDesignPath(to.path);
    const path = stripOldPrefix(to.path);
    const loginPath = old ? '/old/login' : '/login';
    const homePath = old ? '/old/home' : '/home';

    if ((isAuthOnly(path) || isAdminOnly(path)) && !auth.isAuthenticated) {
      return { path: loginPath, query: { redirect: to.fullPath } };
    }

    if (auth.isAuthenticated && !auth.currentUser) {
      void auth.fetchCurrentUser();
    }

    if (auth.isAuthenticated && GUEST_ONLY_PATHS.has(path)) {
      return homePath;
    }

    if (isAdminOnly(path)) {
      if (auth.isAuthenticated && !auth.currentUser) {
        await auth.fetchCurrentUser();
      }
      if (!auth.isAuthenticated) {
        return { path: loginPath, query: { redirect: to.fullPath } };
      }
      if (!auth.isAdmin && !auth.isModerator) {
        return homePath;
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
