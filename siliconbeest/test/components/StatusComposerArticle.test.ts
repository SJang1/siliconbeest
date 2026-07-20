import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import StatusComposer from '@/components/status/StatusComposer.vue';
import { pollMediaDescription, updateMedia, uploadMedia } from '@/api/mastodon/media';
import { useAuthStore } from '@/stores/auth';
import { useComposeStore } from '@/stores/compose';
import { createTestI18n } from '../helpers';

vi.mock('@/composables/useEmojis', () => ({
  useEmojis: () => ({
    fetchCustomEmojis: vi.fn(),
    searchEmojis: vi.fn(() => []),
  }),
}));

vi.mock('@/api/mastodon/search', () => ({
  search: vi.fn(),
}));

vi.mock('@/api/mastodon/media', () => ({
  uploadMedia: vi.fn(),
  pollMediaDescription: vi.fn(),
  updateMedia: vi.fn(),
}));

describe('StatusComposer Article selector', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    vi.mocked(uploadMedia).mockReset();
    vi.mocked(pollMediaDescription).mockReset();
    vi.mocked(updateMedia).mockReset();
  });

  it('shows an explicit post type selector and reveals Article fields', async () => {
    const wrapper = mount(StatusComposer, {
      global: { plugins: [createTestI18n()] },
    });

    const noteButton = wrapper.get('[data-testid="compose-type-note"]');
    const articleButton = wrapper.get('[data-testid="compose-type-article"]');

    expect(noteButton.attributes('aria-checked')).toBe('true');
    expect(articleButton.text()).toContain('Long-form Article');
    expect(wrapper.find('[aria-label="Toggle content warning"]').exists()).toBe(true);
    expect(wrapper.find('[aria-label="Add poll"]').exists()).toBe(true);

    await articleButton.trigger('click');

    expect(articleButton.attributes('aria-checked')).toBe('true');
    expect(wrapper.find('[aria-label="Add media"]').exists()).toBe(true);
    expect(wrapper.find('[aria-label="Emoji"]').exists()).toBe(true);
    expect(wrapper.find('[aria-label="Toggle content warning"]').exists()).toBe(false);
    expect(wrapper.find('[aria-label="Add poll"]').exists()).toBe(false);
    expect(wrapper.get('input[placeholder="Article title"]').exists()).toBe(true);
    expect(wrapper.get('textarea[placeholder="Article summary (optional)"]').exists()).toBe(true);
    expect(wrapper.get('textarea[placeholder="Write the long-form body in Markdown..."]').exists()).toBe(true);
    expect(wrapper.text()).toContain('Markdown headings');
  });

  it('inserts uploaded Article images into the body as Markdown', async () => {
    const auth = useAuthStore();
    auth.setToken('test-token');
    vi.mocked(uploadMedia).mockResolvedValue({
      data: {
        id: 'media-1',
        type: 'image',
        url: 'https://cdn.example/article-image.png',
        preview_url: null,
        remote_url: null,
        meta: null,
        description: null,
        blurhash: null,
      },
      headers: new Headers(),
    });

    const wrapper = mount(StatusComposer, {
      global: { plugins: [createTestI18n()] },
    });
    await wrapper.get('[data-testid="compose-type-article"]').trigger('click');

    const input = wrapper.get<HTMLInputElement>('input[type="file"]');
    const file = new File(['image'], 'diagram.png', { type: 'image/png' });
    Object.defineProperty(input.element, 'files', { value: [file], configurable: true });
    await input.trigger('change');
    await flushPromises();

    const body = wrapper.get<HTMLTextAreaElement>('textarea[placeholder="Write the long-form body in Markdown..."]');
    expect(body.element.value).toBe('![diagram](https://cdn.example/article-image.png)');
    expect(useComposeStore().mediaAttachments).toEqual([]);
  });

  it('replaces an untouched Article image label with generated ALT text', async () => {
    const auth = useAuthStore();
    auth.setToken('test-token');
    let resolveDescription!: (media: ReturnType<typeof pendingAttachment>) => void;
    vi.mocked(uploadMedia).mockResolvedValue({
      data: pendingAttachment(),
      headers: new Headers(),
    });
    vi.mocked(pollMediaDescription).mockImplementation(() => new Promise((resolve) => {
      resolveDescription = resolve;
    }));

    const wrapper = mount(StatusComposer, {
      global: { plugins: [createTestI18n()] },
    });
    await wrapper.get('[data-testid="compose-type-article"]').trigger('click');
    await uploadThroughComposer(wrapper);

    const body = wrapper.get<HTMLTextAreaElement>(
      'textarea[placeholder="Write the long-form body in Markdown..."]',
    );
    expect(body.element.value).toBe('![diagram](https://cdn.example/article-image.png)');

    resolveDescription(pendingAttachment('complete', 'A labelled architecture diagram.'));
    await flushPromises();

    expect(body.element.value).toBe(
      '![A labelled architecture diagram.](https://cdn.example/article-image.png)',
    );
    expect(wrapper.get('[data-testid="generated-alt-notice"]').text())
      .toContain('may be inaccurate');

    await body.setValue('![My reviewed architecture diagram](https://cdn.example/article-image.png)');
    expect(wrapper.find('[data-testid="generated-alt-notice"]').exists()).toBe(false);
  });

  it('does not replace Article Markdown that the author edited while ALT was generating', async () => {
    const auth = useAuthStore();
    auth.setToken('test-token');
    let resolveDescription!: (media: ReturnType<typeof pendingAttachment>) => void;
    vi.mocked(uploadMedia).mockResolvedValue({
      data: pendingAttachment(),
      headers: new Headers(),
    });
    vi.mocked(pollMediaDescription).mockImplementation(() => new Promise((resolve) => {
      resolveDescription = resolve;
    }));

    const wrapper = mount(StatusComposer, {
      global: { plugins: [createTestI18n()] },
    });
    await wrapper.get('[data-testid="compose-type-article"]').trigger('click');
    await uploadThroughComposer(wrapper);

    const body = wrapper.get<HTMLTextAreaElement>(
      'textarea[placeholder="Write the long-form body in Markdown..."]',
    );
    await body.setValue('![My own diagram description](https://cdn.example/article-image.png)');
    resolveDescription(pendingAttachment('complete', 'AI description'));
    await flushPromises();

    expect(body.element.value).toBe(
      '![My own diagram description](https://cdn.example/article-image.png)',
    );
    expect(wrapper.find('[data-testid="generated-alt-notice"]').exists()).toBe(false);
  });

  it('tracks an ALT description that already completed during Article upload', async () => {
    const auth = useAuthStore();
    auth.setToken('test-token');
    vi.mocked(uploadMedia).mockResolvedValue({
      data: pendingAttachment('complete', 'An immediately generated diagram.'),
      headers: new Headers(),
    });

    const wrapper = mount(StatusComposer, {
      global: { plugins: [createTestI18n()] },
    });
    await wrapper.get('[data-testid="compose-type-article"]').trigger('click');
    await uploadThroughComposer(wrapper);

    const body = wrapper.get<HTMLTextAreaElement>(
      'textarea[placeholder="Write the long-form body in Markdown..."]',
    );
    expect(wrapper.get('[data-testid="generated-alt-notice"]').exists()).toBe(true);

    await body.setValue('![Reviewed immediate diagram](https://cdn.example/article-image.png)');
    expect(wrapper.find('[data-testid="generated-alt-notice"]').exists()).toBe(false);
  });

  it('shows generation progress and keeps manually entered ALT text editable', async () => {
    const auth = useAuthStore();
    auth.setToken('test-token');
    let resolveDescription!: (media: ReturnType<typeof pendingAttachment>) => void;
    vi.mocked(uploadMedia).mockResolvedValue({
      data: pendingAttachment(),
      headers: new Headers(),
    });
    vi.mocked(pollMediaDescription).mockImplementation(() => new Promise((resolve) => {
      resolveDescription = resolve;
    }));
    vi.mocked(updateMedia).mockResolvedValue({
      data: pendingAttachment('complete', 'My own description'),
      headers: new Headers(),
    });

    const wrapper = mount(StatusComposer, {
      global: { plugins: [createTestI18n()] },
    });
    await uploadThroughComposer(wrapper);

    expect(wrapper.get('[data-testid="media-alt-generating"]').text())
      .toContain('Generating ALT text');
    await wrapper.get('[data-testid="media-alt-button"]').trigger('click');
    const altInput = wrapper.get<HTMLTextAreaElement>('textarea[maxlength="1500"]');
    await altInput.setValue('My own description');

    resolveDescription(pendingAttachment('complete', 'AI description'));
    await flushPromises();
    expect(altInput.element.value).toBe('My own description');

    const saveButton = wrapper.findAll('button').find((button) => button.text() === 'Save');
    expect(saveButton).toBeDefined();
    await saveButton!.trigger('click');
    await flushPromises();

    expect(updateMedia).toHaveBeenCalledWith(
      'media-1',
      { description: 'My own description' },
      'test-token',
    );
    expect(useComposeStore().mediaAttachments[0]?.description).toBe('My own description');
  });

  it('shows an actionable error when automatic ALT generation fails', async () => {
    const auth = useAuthStore();
    auth.setToken('test-token');
    vi.mocked(uploadMedia).mockResolvedValue({
      data: pendingAttachment(),
      headers: new Headers(),
    });
    vi.mocked(pollMediaDescription).mockResolvedValue(
      pendingAttachment('failed', null, 'rate_limited'),
    );

    const wrapper = mount(StatusComposer, {
      global: { plugins: [createTestI18n()] },
    });
    await uploadThroughComposer(wrapper);

    await vi.waitFor(() => {
      expect(useComposeStore().mediaAttachments[0]?.description_generation_status)
        .toBe('failed');
    });
    await wrapper.vm.$nextTick();
    expect(wrapper.get('[data-testid="media-alt-failed"]').text()).toContain('ALT failed');
    await wrapper.get('[data-testid="media-alt-button"]').trigger('click');
    expect(wrapper.get('[data-testid="media-alt-failure-message"]').text())
      .toContain('Too many automatic ALT requests');
    expect(wrapper.get<HTMLTextAreaElement>('textarea[maxlength="1500"]').element.disabled)
      .toBe(false);
  });

  it('shows the generated ALT accuracy notice until the author saves a review', async () => {
    const auth = useAuthStore();
    auth.setToken('test-token');
    let resolveDescription!: (media: ReturnType<typeof pendingAttachment>) => void;
    vi.mocked(uploadMedia).mockResolvedValue({
      data: pendingAttachment(),
      headers: new Headers(),
    });
    vi.mocked(pollMediaDescription).mockImplementation(() => new Promise((resolve) => {
      resolveDescription = resolve;
    }));
    vi.mocked(updateMedia).mockResolvedValue({
      data: pendingAttachment('complete', 'Reviewed description.'),
      headers: new Headers(),
    });

    const wrapper = mount(StatusComposer, {
      global: { plugins: [createTestI18n()] },
    });
    await uploadThroughComposer(wrapper);

    expect(wrapper.find('[data-testid="generated-alt-notice"]').exists()).toBe(false);
    resolveDescription(pendingAttachment('complete', 'Generated description.'));
    await flushPromises();

    expect(wrapper.get('[data-testid="generated-alt-notice"]').text())
      .toContain('may be inaccurate');

    await wrapper.get('[data-testid="media-alt-button"]').trigger('click');
    await wrapper.get<HTMLTextAreaElement>('textarea[maxlength="1500"]')
      .setValue('Reviewed description.');
    const saveButton = wrapper.findAll('button').find((button) => button.text() === 'Save');
    await saveButton!.trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="generated-alt-notice"]').exists()).toBe(false);
  });

  it('keeps an intentional blank save when a stale polling response arrives later', async () => {
    const auth = useAuthStore();
    auth.setToken('test-token');
    let resolveDescription!: (media: ReturnType<typeof pendingAttachment>) => void;
    vi.mocked(uploadMedia).mockResolvedValue({
      data: pendingAttachment(),
      headers: new Headers(),
    });
    vi.mocked(pollMediaDescription).mockImplementation(() => new Promise((resolve) => {
      resolveDescription = resolve;
    }));
    vi.mocked(updateMedia).mockResolvedValue({
      data: pendingAttachment('complete', null),
      headers: new Headers(),
    });

    const wrapper = mount(StatusComposer, {
      global: { plugins: [createTestI18n()] },
    });
    await uploadThroughComposer(wrapper);
    await wrapper.get('[data-testid="media-alt-button"]').trigger('click');
    const saveButton = wrapper.findAll('button').find((button) => button.text() === 'Save');
    await saveButton!.trigger('click');
    await flushPromises();

    resolveDescription(pendingAttachment('complete', 'A stale AI description'));
    await flushPromises();

    expect(useComposeStore().mediaAttachments[0]?.description).toBeNull();
    expect(useComposeStore().mediaAttachments[0]?.description_generation_status).toBe('complete');
  });

  it('locks the active ALT editor until its save response is applied', async () => {
    const auth = useAuthStore();
    auth.setToken('test-token');
    let resolveSave!: (response: Awaited<ReturnType<typeof updateMedia>>) => void;
    vi.mocked(uploadMedia).mockResolvedValue({
      data: pendingAttachment('disabled', null),
      headers: new Headers(),
    });
    vi.mocked(updateMedia).mockImplementation(() => new Promise((resolve) => {
      resolveSave = resolve;
    }));

    const wrapper = mount(StatusComposer, {
      global: { plugins: [createTestI18n()] },
    });
    await uploadThroughComposer(wrapper);
    await wrapper.get('[data-testid="media-alt-button"]').trigger('click');
    const altInput = wrapper.get<HTMLTextAreaElement>('textarea[maxlength="1500"]');
    await altInput.setValue('Saved description');
    const saveButton = wrapper.findAll('button').find((button) => button.text() === 'Save');
    await saveButton!.trigger('click');

    expect(saveButton!.attributes('disabled')).toBeDefined();
    expect(altInput.attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="media-alt-close"]').attributes('disabled')).toBeDefined();

    resolveSave({
      data: pendingAttachment('complete', 'Saved description'),
      headers: new Headers(),
    });
    await flushPromises();
    expect(wrapper.find('textarea[maxlength="1500"]').exists()).toBe(false);
    expect(useComposeStore().mediaAttachments[0]?.description).toBe('Saved description');
  });
});

function pendingAttachment(
  status: 'pending' | 'complete' | 'failed' | 'disabled' = 'pending',
  description: string | null = null,
  error: 'rate_limited' | null = null,
) {
  return {
    id: 'media-1',
    type: 'image' as const,
    url: 'https://cdn.example/article-image.png',
    preview_url: null,
    remote_url: null,
    meta: null,
    description,
    description_generation_status: status,
    description_generation_error: error,
    blurhash: null,
  };
}

async function uploadThroughComposer(wrapper: ReturnType<typeof mount>) {
  const input = wrapper.get<HTMLInputElement>('input[type="file"]');
  const file = new File(['image'], 'diagram.png', { type: 'image/png' });
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true });
  await input.trigger('change');
  await flushPromises();
}
