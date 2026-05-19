import { useAuthStore } from '@/stores/auth';

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

  if (isAuthOnly(to.path) && !token.value) {
    return navigateTo({ path: '/login', query: { redirect: to.fullPath } });
  }
});
