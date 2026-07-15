import { ApiError } from '@/api/client';

export function getApiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    return error.description || error.error || error.message || fallback;
  }

  return error instanceof Error ? error.message || fallback : fallback;
}

export function hasErrorName(error: unknown, names: readonly string[]): boolean {
  return error instanceof Error && names.includes(error.name);
}
