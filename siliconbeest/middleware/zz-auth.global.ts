import { useAuthStore } from '@/stores/auth';
import { isOldDesignPath, stripOldPrefix } from '@/utils/designVersion';

const AUTH_TOKEN_COOKIE = 'siliconbeest_token';

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
  '/admin',
];

const GUEST_ONLY_PATHS = new Set(['/', '/login', '/register']);

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

  // /old/* mirrors the canonical routes with the classic design; apply the
  // same rules and keep redirect targets inside the /old tree.
  const old = isOldDesignPath(to.path);
  const path = stripOldPrefix(to.path);

  if (GUEST_ONLY_PATHS.has(path) && token.value) {
    return navigateTo(old ? '/old/home' : '/home');
  }

  if (isAuthOnly(path) && !token.value) {
    return navigateTo({ path: old ? '/old/login' : '/login', query: { redirect: to.fullPath } });
  }
});
