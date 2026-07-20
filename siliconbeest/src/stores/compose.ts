import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import type { StatusVisibility, MediaAttachment, Status, QuotePolicy } from '@/types/mastodon';
import { createStatus, editStatus, getStatusSource } from '@/api/mastodon/statuses';
import { updateCredentials } from '@/api/mastodon/accounts';
import { pollMediaDescription, uploadMedia } from '@/api/mastodon/media';
import { useAuthStore } from './auth';
import { useStatusesStore } from './statuses';
import { useTimelinesStore } from './timelines';

const MAX_NOTE_CHARACTERS = 500;
const MAX_ARTICLE_CHARACTERS = 100_000;
const MAX_ARTICLE_TITLE_CHARACTERS = 200;

function plainTextFromHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

export const useComposeStore = defineStore('compose', () => {
  const defaultVisibility = ref<StatusVisibility>('public');
  const defaultQuotePolicy = ref<QuotePolicy>('public');

  // Sync defaultVisibility from currentUser.source.privacy when user data loads
  const auth = useAuthStore();
  watch(() => auth.currentUser?.source?.privacy, (privacy) => {
    if (privacy) defaultVisibility.value = privacy;
  }, { immediate: true });
  watch(() => auth.currentUser?.source?.quote_policy, (policy) => {
    defaultQuotePolicy.value = policy ?? 'public';
  }, { immediate: true });
  const text = ref('');
  const objectType = ref<'Note' | 'Article'>('Note');
  const title = ref('');
  const articleSummary = ref('');
  const contentWarning = ref('');
  const showContentWarning = ref(false);
  const visibility = ref<StatusVisibility>(defaultVisibility.value);
  const sensitive = ref(false);
  const inReplyToId = ref<string | null>(null);
  const inReplyToStatus = ref<Status | null>(null);
  const quoteId = ref<string | null>(null);
  const quoteStatus = ref<Status | null>(null);
  const quotePolicy = ref<QuotePolicy>(defaultQuotePolicy.value);
  const editingId = ref<string | null>(null);
  const mediaAttachments = ref<MediaAttachment[]>([]);
  const uploading = ref(false);
  const publishing = ref(false);
  const activeMediaDescriptionPolls = new Map<string, {
    controller: AbortController;
    promise: Promise<MediaAttachment | null>;
  }>();
  const manuallyEditedMediaDescriptions = new Set<string>();
  const unreviewedGeneratedMediaDescriptionIds = ref<string[]>([]);
  // Incremented on each successful publish — composers watch this to clear
  // their local drafts only once the post has really gone out
  const publishedTick = ref(0);
  // Default language from browser/i18n locale
  const language = ref(
    typeof navigator === 'undefined' ? 'en' : (navigator.language?.split('-')[0] || 'en'),
  );
  const pollOptions = ref<string[]>([]);
  const pollExpiresIn = ref(86400); // 24h default
  const pollMultiple = ref(false);
  const showPoll = ref(false);

  const charCount = computed(() => text.value.length);
  const characterLimit = computed(() => objectType.value === 'Article' ? MAX_ARTICLE_CHARACTERS : MAX_NOTE_CHARACTERS);
  const remaining = computed(() => characterLimit.value - charCount.value);
  const canPublish = computed(
    () =>
      !publishing.value &&
      !uploading.value &&
      (text.value.trim().length > 0 || mediaAttachments.value.length > 0) &&
      (objectType.value !== 'Article' || (title.value.trim().length > 0 && title.value.length <= MAX_ARTICLE_TITLE_CHARACTERS)) &&
      remaining.value >= 0,
  );

  function reset() {
    for (const poll of activeMediaDescriptionPolls.values()) poll.controller.abort();
    activeMediaDescriptionPolls.clear();
    manuallyEditedMediaDescriptions.clear();
    unreviewedGeneratedMediaDescriptionIds.value = [];
    text.value = '';
    objectType.value = 'Note';
    title.value = '';
    articleSummary.value = '';
    contentWarning.value = '';
    showContentWarning.value = false;
    visibility.value = defaultVisibility.value;
    sensitive.value = false;
    inReplyToId.value = null;
    inReplyToStatus.value = null;
    quoteId.value = null;
    quoteStatus.value = null;
    quotePolicy.value = defaultQuotePolicy.value;
    editingId.value = null;
    mediaAttachments.value = [];
    uploading.value = false;
    publishing.value = false;
    pollOptions.value = [];
    pollExpiresIn.value = 86400;
    pollMultiple.value = false;
    showPoll.value = false;
  }

  async function setDefaultVisibility(v: StatusVisibility) {
    defaultVisibility.value = v;
    const auth = useAuthStore();
    if (auth.token) {
      const formData = new FormData();
      formData.append('source[privacy]', v);
      await updateCredentials(auth.token, formData);
      await auth.fetchCurrentUser();
    }
  }

  async function setDefaultQuotePolicy(policy: QuotePolicy) {
    defaultQuotePolicy.value = policy;
    quotePolicy.value = policy;
    const auth = useAuthStore();
    if (auth.token) {
      const formData = new FormData();
      formData.append('source[quote_policy]', policy);
      await updateCredentials(auth.token, formData);
      await auth.fetchCurrentUser();
    }
  }

  function setReplyTo(status: Status) {
    inReplyToId.value = status.id;
    inReplyToStatus.value = status;
    visibility.value = status.visibility;
    // Prepend mention
    const mention = `@${status.account.acct} `;
    if (!text.value.startsWith(mention)) {
      text.value = mention + text.value;
    }
  }

  function setQuote(status: Status) {
    quoteId.value = status.id;
    quoteStatus.value = status;
    if (visibility.value === 'direct') {
      visibility.value = status.visibility === 'private' ? 'private' : defaultVisibility.value;
    }
  }

  function clearQuote() {
    quoteId.value = null;
    quoteStatus.value = null;
  }

  function setEditing(status: Status) {
    // Editing starts a clean compose session so stale reply, quote, poll, or
    // draft state cannot be submitted with the edited status.
    reset();
    editingId.value = status.id;
    objectType.value = status.object_type === 'Article' ? 'Article' : 'Note';
    title.value = status.title ?? '';
    articleSummary.value = status.article_summary ?? '';
    text.value = status.text ?? plainTextFromHtml(status.content ?? '');
    contentWarning.value = status.spoiler_text;
    showContentWarning.value = !!status.spoiler_text;
    visibility.value = status.visibility;
    sensitive.value = status.sensitive;
    mediaAttachments.value = [...status.media_attachments];
    language.value = status.language ?? 'en';
    quotePolicy.value = status.quote_policy ?? defaultQuotePolicy.value;
  }

  async function beginEditing(status: Status) {
    const auth = useAuthStore();
    if (!auth.token) return false;

    try {
      const { data: source } = await getStatusSource(status.id, auth.token);
      setEditing({
        ...status,
        object_type: source.object_type,
        title: source.title,
        article_summary: source.article_summary,
        text: source.text,
        spoiler_text: source.spoiler_text,
      });
    } catch {
      // The source endpoint is authoritative, but the cached status still
      // provides a usable fallback if the request fails temporarily.
      setEditing(status);
    }
    return true;
  }

  async function addMedia(file: File) {
    const auth = useAuthStore();
    if (!auth.token || mediaAttachments.value.length >= 4) return;

    uploading.value = true;
    try {
      const { data } = await uploadMedia(file, { token: auth.token });
      mediaAttachments.value.push(data);
      if (data.description_generation_status === 'pending') {
        void startMediaDescriptionPolling(data, auth.token);
      } else if (
        data.description_generation_status === 'complete'
        && data.description
      ) {
        markGeneratedMediaDescriptionForReview(data.id);
      }
      return data;
    } finally {
      uploading.value = false;
    }
  }

  const hasUnreviewedGeneratedAltText = computed(
    () => unreviewedGeneratedMediaDescriptionIds.value.length > 0,
  );

  function markGeneratedMediaDescriptionForReview(id: string) {
    if (!unreviewedGeneratedMediaDescriptionIds.value.includes(id)) {
      unreviewedGeneratedMediaDescriptionIds.value.push(id);
    }
  }

  function markMediaDescriptionReviewed(id: string) {
    unreviewedGeneratedMediaDescriptionIds.value =
      unreviewedGeneratedMediaDescriptionIds.value.filter((mediaId) => mediaId !== id);
  }

  function setLocalMediaDescriptionStatus(
    media: MediaAttachment,
    status: NonNullable<MediaAttachment['description_generation_status']>,
    error: MediaAttachment['description_generation_error'] = null,
  ) {
    media.description_generation_status = status;
    media.description_generation_error = error;
    const attachedIndex = mediaAttachments.value.findIndex((item) => item.id === media.id);
    const attached = mediaAttachments.value[attachedIndex];
    if (attachedIndex >= 0 && attached) {
      mediaAttachments.value[attachedIndex] = {
        ...attached,
        description_generation_status: status,
        description_generation_error: error,
      };
    }
  }

  function startMediaDescriptionPolling(
    media: MediaAttachment,
    token: string,
  ): Promise<MediaAttachment | null> {
    const existing = activeMediaDescriptionPolls.get(media.id);
    if (existing) return existing.promise;

    const controller = new AbortController();
    const promise = pollMediaDescription(media.id, token, { signal: controller.signal })
      .then((latest) => {
        if (
          controller.signal.aborted
          || manuallyEditedMediaDescriptions.has(media.id)
        ) {
          return null;
        }
        if (!latest) {
          setLocalMediaDescriptionStatus(media, 'failed', 'timeout');
          return null;
        }

        const resolved = latest.description_generation_status === 'pending'
          ? {
              ...latest,
              description_generation_status: 'failed' as const,
              description_generation_error: 'timeout' as const,
            }
          : latest;
        Object.assign(media, resolved);
        const attachedIndex = mediaAttachments.value.findIndex((item) => item.id === media.id);
        const attached = mediaAttachments.value[attachedIndex];
        if (attachedIndex >= 0 && attached) {
          mediaAttachments.value[attachedIndex] = {
            ...attached,
            ...resolved,
          };
        }
        if (
          resolved.description_generation_status === 'complete'
          && resolved.description
        ) {
          markGeneratedMediaDescriptionForReview(media.id);
        }
        return resolved;
      })
      .catch(() => {
        if (
          !controller.signal.aborted
          && !manuallyEditedMediaDescriptions.has(media.id)
        ) {
          setLocalMediaDescriptionStatus(media, 'failed', 'timeout');
        }
        return null;
      })
      .finally(() => {
        if (activeMediaDescriptionPolls.get(media.id)?.controller === controller) {
          activeMediaDescriptionPolls.delete(media.id);
        }
      });

    activeMediaDescriptionPolls.set(media.id, { controller, promise });
    return promise;
  }

  function waitForMediaDescription(id: string): Promise<MediaAttachment | null> {
    const active = activeMediaDescriptionPolls.get(id);
    if (active) return active.promise;
    return Promise.resolve(mediaAttachments.value.find((media) => media.id === id) ?? null);
  }

  function markMediaDescriptionEdited(id: string) {
    manuallyEditedMediaDescriptions.add(id);
    activeMediaDescriptionPolls.get(id)?.controller.abort();
    activeMediaDescriptionPolls.delete(id);
  }

  function resumeMediaDescriptionPolling(id: string) {
    const auth = useAuthStore();
    const media = mediaAttachments.value.find((item) => item.id === id);
    manuallyEditedMediaDescriptions.delete(id);
    if (
      auth.token
      && media?.description_generation_status === 'pending'
    ) {
      void startMediaDescriptionPolling(media, auth.token);
    }
  }

  function removeMedia(id: string, cancelDescriptionPolling = true) {
    if (cancelDescriptionPolling) {
      activeMediaDescriptionPolls.get(id)?.controller.abort();
      activeMediaDescriptionPolls.delete(id);
      manuallyEditedMediaDescriptions.delete(id);
      markMediaDescriptionReviewed(id);
    }
    mediaAttachments.value = mediaAttachments.value.filter((m) => m.id !== id);
  }

  async function publish() {
    const auth = useAuthStore();
    if (!auth.token || !canPublish.value) return;

    publishing.value = true;
    try {
      const params = {
        status: text.value,
        object_type: objectType.value,
        title: objectType.value === 'Article' ? title.value.trim() : undefined,
        summary: objectType.value === 'Article' ? articleSummary.value.trim() || undefined : undefined,
        media_ids: mediaAttachments.value.map((m) => m.id),
        in_reply_to_id: inReplyToId.value ?? undefined,
        sensitive: sensitive.value,
        spoiler_text: showContentWarning.value ? contentWarning.value : undefined,
        visibility: visibility.value,
        language: language.value,
        quote_id: quoteId.value ?? undefined,
        quote_policy: quotePolicy.value,
        poll:
          showPoll.value && pollOptions.value.length >= 2
            ? {
                options: pollOptions.value.filter((o) => o.trim()),
                expires_in: pollExpiresIn.value,
                multiple: pollMultiple.value,
              }
            : undefined,
      };

      let data: Status;

      if (editingId.value) {
        const res = await editStatus(editingId.value, params, auth.token);
        data = res.data;
      } else {
        const res = await createStatus(params, auth.token);
        data = res.data;
      }

      // Cache and prepend to timeline
      const statusStore = useStatusesStore();
      statusStore.cacheStatus(data);

      if (!editingId.value) {
        const timelinesStore = useTimelinesStore();
        timelinesStore.prependStatus('home', data.id);
        if (timelinesStore.timelines.has('social')) {
          timelinesStore.prependStatus('social', data.id);
        }
        if (data.visibility === 'public') {
          timelinesStore.prependStatus('public', data.id);
          timelinesStore.prependStatus('local', data.id);
        }
      }

      reset();
      publishedTick.value++;
      return data;
    } finally {
      publishing.value = false;
    }
  }

  return {
    text,
    objectType,
    title,
    articleSummary,
    contentWarning,
    showContentWarning,
    visibility,
    defaultVisibility,
    defaultQuotePolicy,
    setDefaultVisibility,
    setDefaultQuotePolicy,
    sensitive,
    inReplyToId,
    inReplyToStatus,
    quoteId,
    quoteStatus,
    quotePolicy,
    editingId,
    mediaAttachments,
    uploading,
    publishing,
    publishedTick,
    language,
    pollOptions,
    pollExpiresIn,
    pollMultiple,
    showPoll,
    charCount,
    remaining,
    characterLimit,
    canPublish,
    hasUnreviewedGeneratedAltText,
    reset,
    setReplyTo,
    setQuote,
    clearQuote,
    setEditing,
    beginEditing,
    addMedia,
    waitForMediaDescription,
    markMediaDescriptionEdited,
    markMediaDescriptionReviewed,
    resumeMediaDescriptionPolling,
    removeMedia,
    publish,
  };
});
