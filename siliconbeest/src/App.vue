<script setup lang="ts">
import { onMounted } from 'vue';
import { RouterView, useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { useInstanceStore } from '@/stores/instance';
import { useUiStore } from '@/stores/ui';
import { useNotificationsStore } from '@/stores/notifications';
import { usePublish, type PublishPayload } from '@/composables/usePublish';
import Modal from '@/components/common/Modal.vue';
import StatusComposer from '@/components/status/StatusComposer.vue';

const auth = useAuthStore();
const instance = useInstanceStore();
const ui = useUiStore();
const notifStore = useNotificationsStore();
const router = useRouter();
const { publish } = usePublish();

async function handleGlobalCompose(payload: PublishPayload) {
  await publish(payload);
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

  // Set dynamic favicon — Worker serves /favicon.ico from R2 (admin-uploaded)
  // with SVG fallback, so we just need to ensure the link tag exists and
  // bust the cache when the instance data is loaded
  const link = document.querySelector("link[rel='icon']") as HTMLLinkElement;
  if (link) {
    link.href = '/favicon.ico';
  }

  // Register service worker for Web Push notifications
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // SW registration failed — push notifications won't work
    });
  }
});
</script>

<template>
  <RouterView />

  <!-- Global compose modal -->
  <Modal :open="ui.composeModalOpen" :title="$t('compose.title')" @close="ui.closeComposeModal()">
    <StatusComposer @submit="handleGlobalCompose" />
  </Modal>
</template>
