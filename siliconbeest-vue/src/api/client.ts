const API_BASE = '/api';

export class ApiError extends Error {
  constructor(
    public status: number,
    public error: string,
    public description?: string,
  ) {
    super(error);
    this.name = 'ApiError';
  }
}

export interface ApiResponse<T> {
  data: T;
  headers: Headers;
}

interface FetchOpts extends Omit<RequestInit, 'headers'> {
  token?: string;
  headers?: Record<string, string>;
}

export async function apiFetch<T>(
  path: string,
  opts?: FetchOpts,
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...opts?.headers,
  };

  if (opts?.token) {
    headers['Authorization'] = `Bearer ${opts.token}`;
  }

  const { token: _, headers: __, ...fetchOpts } = opts ?? {};

  const res = await fetch(`${API_BASE}${path}`, {
    ...fetchOpts,
    headers,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({
      error: res.statusText,
    }));
    throw new ApiError(res.status, err.error, err.error_description);
  }

  const data = (await res.json()) as T;
  return { data, headers: res.headers };
}

export async function apiFetchFormData<T>(
  path: string,
  formData: FormData,
  opts?: { token?: string; method?: string },
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {};

  if (opts?.token) {
    headers['Authorization'] = `Bearer ${opts.token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    method: opts?.method ?? 'POST',
    headers,
    body: formData,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({
      error: res.statusText,
    }));
    throw new ApiError(res.status, err.error, err.error_description);
  }

  const data = (await res.json()) as T;
  return { data, headers: res.headers };
}

export function parseLinkHeader(
  header: string | null,
): { next?: string; prev?: string } {
  if (!header) return {};

  const links: Record<string, string> = {};
  const parts = header.split(',');

  for (const part of parts) {
    const match = part.match(/<([^>]+)>;\s*rel="(\w+)"/);
    if (match) {
      const [, url, rel] = match;
      // Extract the path + query from the full URL
      try {
        const parsed = new URL(url, window.location.origin);
        links[rel] = parsed.pathname + parsed.search;
      } catch {
        links[rel] = url;
      }
    }
  }

  return links;
}

export function buildQueryString(
  params: Record<string, string | number | boolean | string[] | undefined>,
): string {
  const searchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) {
        searchParams.append(`${key}[]`, v);
      }
    } else {
      searchParams.set(key, String(value));
    }
  }

  const qs = searchParams.toString();
  return qs ? `?${qs}` : '';
}
