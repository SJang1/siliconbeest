type SetupStatus = {
  setup_required: boolean;
  user_count: number;
};

const SETUP_DONE_COOKIE = 'siliconbeest_setup_done';

export default defineNuxtRouteMiddleware(async (to) => {
  if (to.path.startsWith('/auth/confirm')) return;

  const setupStatus = useState<SetupStatus | null>('setup-status', () => null);
  const setupDone = useCookie<string | null>(SETUP_DONE_COOKIE, {
    path: '/',
    sameSite: 'lax',
  });

  if (setupStatus.value?.setup_required && to.path !== '/setup') {
    return navigateTo('/setup');
  }

  if (setupStatus.value?.setup_required === false) {
    setupDone.value = '1';
    if (to.path === '/setup') {
      return navigateTo('/');
    }
    return;
  }

  if (setupDone.value === '1') {
    if (to.path === '/setup') return;
    return;
  }

  if (import.meta.client) {
    return;
  }

  try {
    setupStatus.value = await $fetch<SetupStatus>('/api/v1/setup');
  } catch {
    return;
  }

  if (setupStatus.value.setup_required && to.path !== '/setup') {
    return navigateTo('/setup');
  }

  if (!setupStatus.value.setup_required && to.path === '/setup') {
    return navigateTo('/');
  }

  if (!setupStatus.value.setup_required) {
    setupDone.value = '1';
  }
});
