import { createPinia, setActivePinia } from 'pinia';
import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Component } from 'vue';
import type { Status } from '@/types/mastodon';
import StatusCard from '@/components/status/StatusCard.vue';
import DeckStatusCard from '@/deck/components/DeckStatusCard.vue';
import LegacyStatusCard from '@/legacy/components/status/StatusCard.vue';
import { createTestI18n } from '../helpers';

function makeArticle(summary = ''): Status {
  return {
    id: 'article-1',
    uri: 'https://example.test/users/author/statuses/article-1',
    created_at: '2026-07-18T00:00:00Z',
    object_type: 'Article',
    title: 'A long article',
    article_summary: summary,
    account: {
      id: 'author',
      username: 'author',
      acct: 'author',
      display_name: 'Author',
      locked: false,
      bot: false,
      discoverable: true,
      group: false,
      created_at: '2026-01-01T00:00:00Z',
      note: '',
      url: 'https://example.test/@author',
      uri: 'https://example.test/users/author',
      avatar: '',
      avatar_static: '',
      header: '',
      header_static: '',
      followers_count: 0,
      following_count: 0,
      statuses_count: 1,
      last_status_at: '2026-07-18',
      emojis: [],
      fields: [],
    },
    content: '<h2>Opening</h2><p>First paragraph.</p><p>Second paragraph.</p><p>Full body only.</p>',
    visibility: 'public',
    sensitive: false,
    spoiler_text: '',
    media_attachments: [],
    application: null,
    mentions: [],
    tags: [],
    emojis: [],
    reblogs_count: 0,
    favourites_count: 0,
    replies_count: 0,
    url: 'https://example.test/@author/article-1',
    in_reply_to_id: null,
    in_reply_to_account_id: null,
    reblog: null,
    poll: null,
    card: null,
    language: 'en',
    text: 'Opening\n\nFirst paragraph.\n\nSecond paragraph.\n\nFull body only.',
    edited_at: null,
  };
}

const variants: Array<{ name: string; component: Component }> = [
  { name: 'Aurora', component: StatusCard },
  { name: 'Deck', component: DeckStatusCard },
  { name: 'Classic', component: LegacyStatusCard },
];

function mountCard(component: Component, status: Status, expanded = false) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createRouter({ history: createMemoryHistory(), routes: [] });
  return mount(component, {
    props: { status, expanded },
    global: {
      plugins: [pinia, router, createTestI18n()],
      stubs: {
        Avatar: true,
        StatusContent: true,
        StatusActions: true,
        DeckStatusActions: true,
        MediaGallery: true,
        PreviewCard: true,
        StatusPoll: true,
        StatusReactions: true,
        DeckStatusReactions: true,
        StatusEngagementDialog: true,
        ReportDialog: true,
        ImageViewer: true,
        Teleport: true,
      },
    },
  });
}

describe.each(variants)('$name Article cards', ({ component }) => {
  beforeEach(() => localStorage.clear());

  it('shows only the summary and a full-article button in timelines', async () => {
    const article = makeArticle('Only this summary belongs in the timeline.');
    const wrapper = mountCard(component, article);

    expect(wrapper.get('[data-testid="article-preview"]').text()).toBe(
      'Only this summary belongs in the timeline.',
    );
    expect(wrapper.find('status-content-stub').exists()).toBe(false);
    const readFullArticle = wrapper.get('[data-testid="read-full-article"]');
    expect(readFullArticle.text()).toBe('Read full article');
    expect(readFullArticle.attributes('href')).toBe('/@author/article-1');

    await readFullArticle.trigger('click');
    expect(wrapper.emitted('navigate')).toBeUndefined();
  });

  it('falls back to a truncated opening when there is no summary', () => {
    const wrapper = mountCard(component, makeArticle());
    const preview = wrapper.get('[data-testid="article-preview"]').text();

    expect(preview).toContain('Opening');
    expect(preview).toContain('...');
    expect(preview).not.toContain('Full body only.');
  });

  it('shows the full body only when the Article card is expanded', () => {
    const wrapper = mountCard(component, makeArticle('Summary'), true);

    expect(wrapper.find('status-content-stub').exists()).toBe(true);
    expect(wrapper.find('[data-testid="read-full-article"]').exists()).toBe(false);
  });

  it('does not expose a sensitive Article preview in timelines', () => {
    const wrapper = mountCard(component, {
      ...makeArticle('Sensitive summary'),
      sensitive: true,
    });

    expect(wrapper.find('[data-testid="article-preview"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="read-full-article"]').exists()).toBe(true);
  });
});
