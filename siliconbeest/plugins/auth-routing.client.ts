import { useAuthStore } from '@/stores/auth';
import { watch } from 'vue';
import {
  isAuroraDesignPath,
  isOldDesignPath,
  stripAuroraPrefix,
  stripOldPrefix,
} from '@/utils/designVersion';

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
const GUEST_ONLY_PATHS = new Set(['/', '/login', '/register', '/auth/registration']);

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
    // /old/* and /aurora/* mirror the canonical routes.
    const old = isOldDesignPath(currentRoute.path);
    const aurora = isAuroraDesignPath(currentRoute.path);
    const path = old
      ? stripOldPrefix(currentRoute.path)
      : aurora
        ? stripAuroraPrefix(currentRoute.path)
        : currentRoute.path;
    const loginPath = old ? '/old/login' : aurora ? '/aurora/login' : '/login';
    const homePath = old ? '/old/home' : aurora ? '/aurora/home' : '/home';

    if ((isAuthOnly(path) || isAdminOnly(path)) && !auth.isAuthenticated) {
      router.replace({ path: loginPath, query: { redirect: currentRoute.fullPath } });
      return;
    }

    const isRegistrationCompletion = path === '/auth/registration'
      && currentRoute.query.ticket !== undefined;

    if (auth.isAuthenticated && GUEST_ONLY_PATHS.has(path) && !isRegistrationCompletion) {
      router.replace(homePath);
    }
  }

  router.beforeEach(async (to) => {
    const auth = useAuthStore();
    auth.syncTokenFromCookie();

    const old = isOldDesignPath(to.path);
    const aurora = isAuroraDesignPath(to.path);
    const path = old ? stripOldPrefix(to.path) : aurora ? stripAuroraPrefix(to.path) : to.path;
    const loginPath = old ? '/old/login' : aurora ? '/aurora/login' : '/login';
    const homePath = old ? '/old/home' : aurora ? '/aurora/home' : '/home';

    if ((isAuthOnly(path) || isAdminOnly(path)) && !auth.isAuthenticated) {
      return { path: loginPath, query: { redirect: to.fullPath } };
    }

    if (auth.isAuthenticated && !auth.currentUser) {
      void auth.fetchCurrentUser();
    }

    const isRegistrationCompletion = path === '/auth/registration' && to.query.ticket !== undefined;

    if (auth.isAuthenticated && GUEST_ONLY_PATHS.has(path) && !isRegistrationCompletion) {
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
