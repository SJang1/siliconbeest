import { useAuthStore } from '@/stores/auth';

const AUTH_TOKEN_COOKIE = 'siliconbeest_token';

export default defineNuxtPlugin({
  name: 'auth-cookie',
  enforce: 'pre',
  dependsOn: ['pinia'],
  setup() {
    const auth = useAuthStore();
    const tokenCookie = useCookie<string | null>(AUTH_TOKEN_COOKIE, {
      path: '/',
      sameSite: 'lax',
    });

    auth.syncTokenFromCookie(tokenCookie.value ?? null);
  },
});
