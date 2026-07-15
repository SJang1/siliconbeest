import {
  isAuroraDesignPath,
  isOldDesignPath,
  toAuroraPath,
  toOldPath,
} from '@/utils/designVersion';

type QueryValue = string | (string | null)[] | null | undefined;

function firstQueryValue(value: QueryValue): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export function getSafeRedirect(
  value: QueryValue,
  fallback = '/home',
): string {
  const candidate = firstQueryValue(value);
  if (!candidate || !candidate.startsWith('/') || candidate.startsWith('//')) {
    return fallback;
  }

  try {
    const parsed = new URL(candidate, 'https://siliconbeest.invalid');
    if (parsed.origin !== 'https://siliconbeest.invalid') return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

export function withCurrentDesign(path: string, currentPath: string): string {
  if (isOldDesignPath(currentPath)) return toOldPath(path);
  if (isAuroraDesignPath(currentPath)) return toAuroraPath(path);
  return path;
}
