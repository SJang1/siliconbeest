import { isOldDesignPath, toOldPath } from '@/utils/designVersion';

/**
 * Keep users who are browsing the classic design (/old/*) inside the /old tree:
 * legacy components link to canonical paths (/home, /@user/...), so in-app
 * navigation out of /old is rewritten to the mirrored /old route when one
 * exists. Leaving the classic design is done via a full page load (the
 * banner's plain <a href>), which does not pass through this guard.
 */
export default defineNuxtPlugin(() => {
  const router = useRouter();

  router.beforeEach((to, from) => {
    if (!isOldDesignPath(from.path)) return;
    if (isOldDesignPath(to.path)) return;

    const target = toOldPath(to.fullPath);
    const resolved = router.resolve(target);
    const name = String(resolved.name ?? '');
    if (name.startsWith('old-') && name !== 'old-not-found') {
      return target;
    }
  });
});
