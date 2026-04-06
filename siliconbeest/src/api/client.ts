const API_BASE = '/api';

// Callback for handling 401 responses globally (set by auth store on init)
let onUnauthorized: (() => void) | null = null;

export function setOnUnauthorized(cb: () => void) {
  onUnauthorized = cb;
}

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

interface FetchOpts extends Omit<RequestInit, 'headers' | 'body'> {
  token?: string;
  headers?: Record<string, string>;
  body?: BodyInit | Record<string, unknown> | null;
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

  const { token: _, headers: __, body: rawBody, ...fetchOpts } = opts ?? {};

  // Auto-stringify body if it's an object (not FormData/string/etc)
  const body = rawBody && typeof rawBody === 'object' && !(rawBody instanceof FormData) && !(rawBody instanceof Blob) && !(rawBody instanceof ArrayBuffer) && !(rawBody instanceof ReadableStream)
    ? JSON.stringify(rawBody)
    : rawBody;

  const res = await fetch(`${API_BASE}${path}`, {
    ...fetchOpts,
    headers,
    body: body as BodyInit | undefined,
  });

  if (!res.ok) {
    // Auto-logout on 401 for authenticated requests
    if (res.status === 401 && opts?.token && onUnauthorized) {
      onUnauthorized();
    }
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
    if (res.status === 401 && opts?.token && onUnauthorized) {
      onUnauthorized();
    }
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
      if (url && rel) {
        // Extract the path + query from the full URL
        try {
          const parsed = new URL(url, window.location.origin);
          links[rel] = parsed.pathname + parsed.search;
        } catch {
          links[rel] = url;
        }
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
