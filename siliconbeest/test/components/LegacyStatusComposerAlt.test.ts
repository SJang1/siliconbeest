import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LegacyStatusComposer from '@/legacy/components/status/StatusComposer.vue';
import { pollMediaDescription, updateMedia, uploadMedia } from '@/api/mastodon/media';
import { useAuthStore } from '@/stores/auth';
import { useComposeStore } from '@/stores/compose';
import type { MediaAttachment } from '@/types/mastodon';
import { createTestI18n } from '../helpers';

vi.mock('@/composables/useEmojis', () => ({
  useEmojis: () => ({
    fetchCustomEmojis: vi.fn(),
    searchEmojis: vi.fn(() => []),
  }),
}));

vi.mock('@/api/mastodon/search', () => ({ search: vi.fn() }));

vi.mock('@/api/mastodon/media', () => ({
  uploadMedia: vi.fn(),
  pollMediaDescription: vi.fn(),
  updateMedia: vi.fn(),
}));

function attachment(
  status: NonNullable<MediaAttachment['description_generation_status']> = 'pending',
  description: string | null = null,
  error: MediaAttachment['description_generation_error'] = null,
): MediaAttachment {
  return {
    id: 'legacy-media-1',
    type: 'image',
    url: 'https://cdn.example/legacy.png',
    preview_url: null,
    remote_url: null,
    meta: null,
    description,
    description_generation_status: status,
    description_generation_error: error,
    blurhash: null,
  };
}

describe('Classic composer automatic ALT', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    vi.mocked(uploadMedia).mockReset();
    vi.mocked(pollMediaDescription).mockReset();
    vi.mocked(updateMedia).mockReset();
    useAuthStore().setToken('legacy-token');
  });

  it('shows pending generation and never replaces text being manually edited', async () => {
    let resolveDescription!: (media: MediaAttachment) => void;
    vi.mocked(uploadMedia).mockResolvedValue({ data: attachment(), headers: new Headers() });
    vi.mocked(pollMediaDescription).mockImplementation(() => new Promise((resolve) => {
      resolveDescription = resolve;
    }));
    vi.mocked(updateMedia).mockResolvedValue({
      data: attachment('complete', 'Classic manual ALT'),
      headers: new Headers(),
    });
    const wrapper = mount(LegacyStatusComposer, {
      global: { plugins: [createTestI18n()] },
    });

    await uploadImage(wrapper);
    expect(wrapper.get('[data-testid="media-alt-generating"]').text())
      .toContain('Generating ALT text');

    await wrapper.get('[data-testid="media-alt-button"]').trigger('click');
    const altInput = wrapper.get<HTMLTextAreaElement>('textarea[maxlength="1500"]');
    await altInput.setValue('Classic manual ALT');
    resolveDescription(attachment('complete', 'AI should not replace this'));
    await flushPromises();
    expect(altInput.element.value).toBe('Classic manual ALT');

    const save = wrapper.findAll('button').find((button) => button.text() === 'Save');
    await save!.trigger('click');
    await flushPromises();
    expect(useComposeStore().mediaAttachments[0]?.description).toBe('Classic manual ALT');
  });

  it('updates untouched Classic Article Markdown after generation completes', async () => {
    let resolveDescription!: (media: MediaAttachment) => void;
    vi.mocked(uploadMedia).mockResolvedValue({ data: attachment(), headers: new Headers() });
    vi.mocked(pollMediaDescription).mockImplementation(() => new Promise((resolve) => {
      resolveDescription = resolve;
    }));
    const wrapper = mount(LegacyStatusComposer, {
      global: { plugins: [createTestI18n()] },
    });
    const articleButton = wrapper.findAll('button').find((button) => button.text() === 'A');
    await articleButton!.trigger('click');
    await uploadImage(wrapper);

    const body = wrapper.get<HTMLTextAreaElement>('textarea[rows="5"]');
    expect(body.element.value).toBe('![legacy](https://cdn.example/legacy.png)');
    resolveDescription(attachment('complete', 'A generated Classic description.'));
    await flushPromises();
    expect(body.element.value).toBe(
      '![A generated Classic description.](https://cdn.example/legacy.png)',
    );
    expect(wrapper.get('[data-testid="generated-alt-notice"]').text())
      .toContain('may be inaccurate');

    await body.setValue('![A reviewed Classic description.](https://cdn.example/legacy.png)');
    expect(wrapper.find('[data-testid="generated-alt-notice"]').exists()).toBe(false);
  });

  it('shows the generated ALT accuracy notice in the Classic composer until review', async () => {
    let resolveDescription!: (media: MediaAttachment) => void;
    vi.mocked(uploadMedia).mockResolvedValue({ data: attachment(), headers: new Headers() });
    vi.mocked(pollMediaDescription).mockImplementation(() => new Promise((resolve) => {
      resolveDescription = resolve;
    }));
    vi.mocked(updateMedia).mockResolvedValue({
      data: attachment('complete', 'Reviewed Classic ALT'),
      headers: new Headers(),
    });
    const wrapper = mount(LegacyStatusComposer, {
      global: { plugins: [createTestI18n()] },
    });

    await uploadImage(wrapper);
    resolveDescription(attachment('complete', 'Generated Classic ALT'));
    await flushPromises();
    expect(wrapper.get('[data-testid="generated-alt-notice"]').text())
      .toContain('may be inaccurate');

    await wrapper.get('[data-testid="media-alt-button"]').trigger('click');
    await wrapper.get<HTMLTextAreaElement>('textarea[maxlength="1500"]')
      .setValue('Reviewed Classic ALT');
    const save = wrapper.findAll('button').find((button) => button.text() === 'Save');
    await save!.trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="generated-alt-notice"]').exists()).toBe(false);
  });

  it('shows failed generation and keeps manual ALT editing available', async () => {
    vi.mocked(uploadMedia).mockResolvedValue({ data: attachment(), headers: new Headers() });
    vi.mocked(pollMediaDescription).mockResolvedValue(
      attachment('failed', null, 'rate_limiter_unavailable'),
    );
    const wrapper = mount(LegacyStatusComposer, {
      global: { plugins: [createTestI18n()] },
    });

    await uploadImage(wrapper);
    await vi.waitFor(() => {
      expect(useComposeStore().mediaAttachments[0]?.description_generation_status)
        .toBe('failed');
    });
    await wrapper.vm.$nextTick();
    expect(wrapper.get('[data-testid="media-alt-failed"]').text()).toContain('ALT failed');
    await wrapper.get('[data-testid="media-alt-button"]').trigger('click');
    expect(wrapper.get('[data-testid="media-alt-failure-message"]').text())
      .toContain('temporarily unavailable');
    expect(wrapper.get<HTMLTextAreaElement>('textarea[maxlength="1500"]').element.disabled)
      .toBe(false);
  });
});

async function uploadImage(wrapper: ReturnType<typeof mount>) {
  const input = wrapper.get<HTMLInputElement>('input[type="file"]');
  const file = new File(['image'], 'legacy.png', { type: 'image/png' });
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true });
  await input.trigger('change');
  await flushPromises();
}
