import { apiFetchFormData, apiFetch } from '../client';
import type { MediaAttachment } from '@/types/mastodon';

export function uploadMedia(
  file: File,
  opts?: { description?: string; focus?: string; token: string },
) {
  const formData = new FormData();
  formData.append('file', file);
  if (opts?.description) formData.append('description', opts.description);
  if (opts?.focus) formData.append('focus', opts.focus);

  return apiFetchFormData<MediaAttachment>('/v2/media', formData, {
    token: opts?.token,
  });
}

export function updateMedia(
  id: string,
  data: { description?: string; focus?: string },
  token: string,
) {
  return apiFetch<MediaAttachment>(`/v1/media/${id}`, {
    method: 'PUT',
    token,
    body: JSON.stringify(data),
  });
}

export function getMedia(id: string, token: string) {
  return apiFetch<MediaAttachment>(`/v1/media/${id}`, { token });
}

const DEFAULT_DESCRIPTION_POLL_ATTEMPTS = 20;
const DEFAULT_DESCRIPTION_POLL_INTERVAL_MS = 1_000;
const DEFAULT_DESCRIPTION_POLL_TIMEOUT_MS = 30_000;

function waitForPollInterval(milliseconds: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Poll the media status for a bounded period while background ALT generation
 * is pending. A null result means the caller cancelled the local wait.
 */
export async function pollMediaDescription(
  id: string,
  token: string,
  options?: {
    signal?: AbortSignal;
    maxAttempts?: number;
    intervalMs?: number;
    timeoutMs?: number;
  },
): Promise<MediaAttachment | null> {
  const maxAttempts = Math.max(
    1,
    options?.maxAttempts ?? DEFAULT_DESCRIPTION_POLL_ATTEMPTS,
  );
  const intervalMs = Math.max(
    0,
    options?.intervalMs ?? DEFAULT_DESCRIPTION_POLL_INTERVAL_MS,
  );
  const timeoutMs = Math.max(
    1,
    options?.timeoutMs ?? DEFAULT_DESCRIPTION_POLL_TIMEOUT_MS,
  );
  const pollController = new AbortController();
  const abortPoll = () => pollController.abort();
  if (options?.signal?.aborted) {
    pollController.abort();
  } else {
    options?.signal?.addEventListener('abort', abortPoll, { once: true });
  }
  let latest: MediaAttachment | null = null;

  const polling = (async () => {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (pollController.signal.aborted) return null;
      if (attempt > 0 && !(await waitForPollInterval(intervalMs, pollController.signal))) {
        return null;
      }

      const response = await apiFetch<MediaAttachment>(`/v1/media/${id}`, {
        token,
        signal: pollController.signal,
      });
      latest = response.data;
      if (latest.description_generation_status !== 'pending') return latest;
    }

    return latest;
  })();

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      pollController.abort();
      reject(new Error('Media description polling timed out'));
    }, timeoutMs);
  });

  try {
    return await Promise.race([polling, timedOut]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    options?.signal?.removeEventListener('abort', abortPoll);
  }
}
