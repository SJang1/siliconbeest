import { useAuthStore } from '@/stores/auth';
import {
  isOldDesignPath,
  stripOldPrefix,
  isAuroraDesignPath,
  stripAuroraPrefix,
} from '@/utils/designVersion';

const AUTH_TOKEN_COOKIE = 'siliconbeest_token';

const AUTH_ONLY_PREFIXES = [
  '/home',
  '/recommended',
  '/timelines/home',
  '/timelines/recommended',
  '/timelines/social',
  '/notifications',
  '/conversations',
  '/bookmarks',
  '/favourites',
  '/lists',
  '/follow-requests',
  '/followed_tags',
  '/settings',
  '/invitations',
  '/admin',
  '/share',
];

const GUEST_ONLY_PATHS = new Set(['/', '/login', '/register', '/auth/registration']);

function isAuthOnly(path: string): boolean {
  return AUTH_ONLY_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export default defineNuxtRouteMiddleware((to) => {
  const setupStatus = useState<{ setup_required: boolean } | null>('setup-status', () => null);
  if (setupStatus.value?.setup_required) return;

  const token = useCookie<string | null>(AUTH_TOKEN_COOKIE, {
    path: '/',
    sameSite: 'lax',
  });
  const auth = useAuthStore();
  auth.syncTokenFromCookie(token.value ?? null);

  // /old/* and /aurora/* mirror the canonical routes with the classic and
  // Aurora designs; apply the same rules and keep redirect targets inside
  // the same tree.
  const old = isOldDesignPath(to.path);
  const aurora = isAuroraDesignPath(to.path);
  const path = old ? stripOldPrefix(to.path) : aurora ? stripAuroraPrefix(to.path) : to.path;

  const isRegistrationCompletion = path === '/auth/registration' && to.query.ticket !== undefined;

  if (GUEST_ONLY_PATHS.has(path) && token.value && !isRegistrationCompletion) {
    return navigateTo(old ? '/old/home' : aurora ? '/aurora/home' : '/home');
  }

  if (isAuthOnly(path) && !token.value) {
    return navigateTo({
      path: old ? '/old/login' : aurora ? '/aurora/login' : '/login',
      query: { redirect: to.fullPath },
    });
  }
});
