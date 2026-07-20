import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pollMediaDescription, uploadMedia } from '@/api/mastodon/media';
import { useAuthStore } from '@/stores/auth';
import { useComposeStore } from '@/stores/compose';
import type { MediaAttachment } from '@/types/mastodon';

vi.mock('@/api/mastodon/media', () => ({
  uploadMedia: vi.fn(),
  pollMediaDescription: vi.fn(),
}));

function attachment(
  status: NonNullable<MediaAttachment['description_generation_status']>,
  description: string | null = null,
): MediaAttachment {
  return {
    id: 'media-1',
    type: 'image',
    url: 'https://cdn.example/media-1.png',
    preview_url: null,
    remote_url: null,
    meta: null,
    description,
    description_generation_status: status,
    blurhash: null,
  };
}

describe('compose media description generation', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    vi.mocked(uploadMedia).mockReset();
    vi.mocked(pollMediaDescription).mockReset();
    useAuthStore().setToken('token-1');
  });

  it('returns the upload immediately and applies the later generated ALT text', async () => {
    vi.mocked(uploadMedia).mockResolvedValue({
      data: attachment('pending'),
      headers: new Headers(),
    });
    vi.mocked(pollMediaDescription).mockResolvedValue(
      attachment('complete', 'A red flower.'),
    );
    const compose = useComposeStore();

    const uploaded = await compose.addMedia(new File(['image'], 'flower.png', {
      type: 'image/png',
    }));
    await Promise.resolve();

    expect(uploaded?.id).toBe('media-1');
    expect(compose.mediaAttachments[0]?.description).toBe('A red flower.');
    expect(compose.mediaAttachments[0]?.description_generation_status).toBe('complete');
    expect(compose.hasUnreviewedGeneratedAltText).toBe(true);

    compose.markMediaDescriptionReviewed('media-1');
    expect(compose.hasUnreviewedGeneratedAltText).toBe(false);
  });

  it('never applies a generated result after the user starts editing ALT text', async () => {
    let resolveDescription!: (media: MediaAttachment) => void;
    vi.mocked(uploadMedia).mockResolvedValue({
      data: attachment('pending'),
      headers: new Headers(),
    });
    vi.mocked(pollMediaDescription).mockImplementation(() => new Promise((resolve) => {
      resolveDescription = resolve;
    }));
    const compose = useComposeStore();

    await compose.addMedia(new File(['image'], 'flower.png', { type: 'image/png' }));
    compose.markMediaDescriptionEdited('media-1');
    compose.mediaAttachments[0]!.description = 'My own description';
    resolveDescription(attachment('complete', 'AI description'));
    await Promise.resolve();
    await Promise.resolve();

    expect(compose.mediaAttachments[0]?.description).toBe('My own description');
    expect(compose.mediaAttachments[0]?.description_generation_status).toBe('pending');
    expect(compose.hasUnreviewedGeneratedAltText).toBe(false);
  });

  it('clears the pending state when polling ends without a response', async () => {
    vi.mocked(uploadMedia).mockResolvedValue({
      data: attachment('pending'),
      headers: new Headers(),
    });
    vi.mocked(pollMediaDescription).mockResolvedValue(null);
    const compose = useComposeStore();

    await compose.addMedia(new File(['image'], 'flower.png', { type: 'image/png' }));
    await Promise.resolve();

    expect(pollMediaDescription).toHaveBeenCalledWith(
      'media-1',
      'token-1',
      { signal: expect.any(AbortSignal) },
    );
    expect(compose.mediaAttachments[0]?.description_generation_status).toBe('failed');
    expect(compose.mediaAttachments[0]?.description_generation_error).toBe('timeout');
  });

  it('does not flag an existing generated description as a new compose-session upload', () => {
    const compose = useComposeStore();
    compose.mediaAttachments = [attachment('complete', 'Existing ALT text.')];

    expect(compose.hasUnreviewedGeneratedAltText).toBe(false);
  });
});
