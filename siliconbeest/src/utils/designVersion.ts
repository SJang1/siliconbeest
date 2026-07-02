/**
 * The previous UI is preserved under /old/* (see pages/old/ and src/legacy/).
 * These helpers let auth middleware treat /old/x like /x and let the app
 * translate between the two trees.
 */
export const OLD_DESIGN_PREFIX = '/old';

export function isOldDesignPath(path: string): boolean {
  return path === OLD_DESIGN_PREFIX || path.startsWith(`${OLD_DESIGN_PREFIX}/`);
}

/** Map an /old/* path (or fullPath with query/hash) to its new-design equivalent. */
export function stripOldPrefix(fullPath: string): string {
  if (fullPath === OLD_DESIGN_PREFIX) return '/';
  if (
    fullPath.startsWith(`${OLD_DESIGN_PREFIX}/`) ||
    fullPath.startsWith(`${OLD_DESIGN_PREFIX}?`) ||
    fullPath.startsWith(`${OLD_DESIGN_PREFIX}#`)
  ) {
    const rest = fullPath.slice(OLD_DESIGN_PREFIX.length);
    return rest.startsWith('/') ? rest : `/${rest}`;
  }
  return fullPath;
}

/** Map a new-design fullPath to its /old/* equivalent. */
export function toOldPath(fullPath: string): string {
  if (isOldDesignPath(fullPath)) return fullPath;
  return fullPath === '/' ? OLD_DESIGN_PREFIX : `${OLD_DESIGN_PREFIX}${fullPath}`;
}
