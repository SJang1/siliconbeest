import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import type { StatusVisibility, MediaAttachment, Status } from '@/types/mastodon';
import { createStatus, editStatus } from '@/api/mastodon/statuses';
import { updateCredentials } from '@/api/mastodon/accounts';
import { uploadMedia } from '@/api/mastodon/media';
import { useAuthStore } from './auth';
import { useStatusesStore } from './statuses';
import { useTimelinesStore } from './timelines';

const MAX_CHARACTERS = 500;

export const useComposeStore = defineStore('compose', () => {
  const defaultVisibility = ref<StatusVisibility>('public');

  // Sync defaultVisibility from currentUser.source.privacy when user data loads
  const auth = useAuthStore();
  watch(() => auth.currentUser?.source?.privacy, (privacy) => {
    if (privacy) defaultVisibility.value = privacy;
  }, { immediate: true });
  const text = ref('');
  const contentWarning = ref('');
  const showContentWarning = ref(false);
  const visibility = ref<StatusVisibility>(defaultVisibility.value);
  const sensitive = ref(false);
  const inReplyToId = ref<string | null>(null);
  const inReplyToStatus = ref<Status | null>(null);
  const editingId = ref<string | null>(null);
  const mediaAttachments = ref<MediaAttachment[]>([]);
  const uploading = ref(false);
  const publishing = ref(false);
  // Default language from browser/i18n locale
  const language = ref(navigator.language?.split('-')[0] || 'en');
  const pollOptions = ref<string[]>([]);
  const pollExpiresIn = ref(86400); // 24h default
  const pollMultiple = ref(false);
  const showPoll = ref(false);

  const charCount = computed(() => text.value.length);
  const remaining = computed(() => MAX_CHARACTERS - charCount.value);
  const canPublish = computed(
    () =>
      !publishing.value &&
      !uploading.value &&
      (text.value.trim().length > 0 || mediaAttachments.value.length > 0) &&
      remaining.value >= 0,
  );

  function reset() {
    text.value = '';
    contentWarning.value = '';
    showContentWarning.value = false;
    visibility.value = defaultVisibility.value;
    sensitive.value = false;
    inReplyToId.value = null;
    inReplyToStatus.value = null;
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

  function setEditing(status: Status) {
    editingId.value = status.id;
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
        media_ids: mediaAttachments.value.map((m) => m.id),
        in_reply_to_id: inReplyToId.value ?? undefined,
        sensitive: sensitive.value,
        spoiler_text: showContentWarning.value ? contentWarning.value : undefined,
        visibility: visibility.value,
        language: language.value,
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
        if (data.visibility === 'public') {
          timelinesStore.prependStatus('public', data.id);
          timelinesStore.prependStatus('local', data.id);
        }
      }

      reset();
      return data;
    } finally {
      publishing.value = false;
    }
  }

  return {
    text,
    contentWarning,
    showContentWarning,
    visibility,
    defaultVisibility,
    setDefaultVisibility,
    sensitive,
    inReplyToId,
    inReplyToStatus,
    editingId,
    mediaAttachments,
    uploading,
    publishing,
    language,
    pollOptions,
    pollExpiresIn,
    pollMultiple,
    showPoll,
    charCount,
    remaining,
    canPublish,
    reset,
    setReplyTo,
    setEditing,
    addMedia,
    removeMedia,
    publish,
  };
});
