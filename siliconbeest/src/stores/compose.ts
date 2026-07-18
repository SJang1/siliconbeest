import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import type { StatusVisibility, MediaAttachment, Status, QuotePolicy } from '@/types/mastodon';
import { createStatus, editStatus } from '@/api/mastodon/statuses';
import { updateCredentials } from '@/api/mastodon/accounts';
import { uploadMedia } from '@/api/mastodon/media';
import { useAuthStore } from './auth';
import { useStatusesStore } from './statuses';
import { useTimelinesStore } from './timelines';

const MAX_NOTE_CHARACTERS = 500;
const MAX_ARTICLE_CHARACTERS = 100_000;
const MAX_ARTICLE_TITLE_CHARACTERS = 200;

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
    text.value = '';
    objectType.value = 'Note';
    title.value = '';
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
    editingId.value = status.id;
    objectType.value = status.object_type === 'Article' ? 'Article' : 'Note';
    title.value = status.title ?? '';
    text.value = status.text ?? '';
    contentWarning.value = status.spoiler_text;
    showContentWarning.value = !!status.spoiler_text;
    visibility.value = status.visibility;
    sensitive.value = status.sensitive;
    mediaAttachments.value = [...status.media_attachments];
    language.value = status.language ?? 'en';
  }

  async function addMedia(file: File) {
    const auth = useAuthStore();
    if (!auth.token || mediaAttachments.value.length >= 4) return;

    uploading.value = true;
    try {
      const { data } = await uploadMedia(file, { token: auth.token });
      mediaAttachments.value.push(data);
    } finally {
      uploading.value = false;
    }
  }

  function removeMedia(id: string) {
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
    reset,
    setReplyTo,
    setQuote,
    clearQuote,
    setEditing,
    addMedia,
    removeMedia,
    publish,
  };
});
