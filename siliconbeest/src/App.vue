<script setup lang="ts">
import { onMounted, computed } from 'vue';
import { RouterView, useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { useInstanceStore } from '@/stores/instance';
import { useUiStore } from '@/stores/ui';
import { useNotificationsStore } from '@/stores/notifications';
import { useComposeStore } from '@/stores/compose';
import { usePublish, type PublishPayload } from '@/composables/usePublish';
import Modal from '@/components/common/Modal.vue';
import StatusComposer from '@/components/status/StatusComposer.vue';

const auth = useAuthStore();
const instance = useInstanceStore();
const ui = useUiStore();
const notifStore = useNotificationsStore();
const composeStore = useComposeStore();
const router = useRouter();
const { publish } = usePublish();

const composeReplyContext = computed(() => {
  if (!composeStore.inReplyToStatus) return undefined;
  const s = composeStore.inReplyToStatus;
  return {
    id: s.id,
    account: s.account,
    mentions: s.mentions,
    visibility: s.visibility,
  };
});

const modalTitle = computed(() => {
  if (composeStore.inReplyToStatus) {
    return undefined; // StatusComposer will show "Replying to @user" internally
  }
  return undefined; // Will use default from $t('compose.title')
});

async function handleGlobalCompose(payload: PublishPayload) {
  await publish(payload);
}

function handleModalClose() {
  ui.closeComposeModal();
  composeStore.reset();
}

onMounted(async () => {
  // Load instance info and verify credentials in parallel
  const promises: Promise<void>[] = [instance.init()];
  if (auth.isAuthenticated) {
    promises.push(auth.fetchCurrentUser());
    promises.push(notifStore.fetch(auth.token!));
    promises.push(notifStore.loadMarker(auth.token!));
  }
  await Promise.allSettled(promises);

  // Set dynamic page title
  document.title = instance.instance?.title || 'SiliconBeest';

  // Set dynamic favicon
  const link = document.querySelector("link[rel='icon']") as HTMLLinkElement;
  if (link) {
    link.href = '/favicon.ico';
  }

  // Register service worker for Web Push notifications
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // SW registration failed
    });
  }
});
</script>

<template>
  <RouterView />

  <!-- Global compose modal -->
  <Modal :open="ui.composeModalOpen" :title="$t('compose.title')" @close="handleModalClose">
    <StatusComposer :reply-to="composeReplyContext" @submit="handleGlobalCompose" />
  </Modal>
</template>
