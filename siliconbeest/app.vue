<script setup lang="ts">
import { computed } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { useComposeStore } from '@/stores/compose';
import { usePublish, type PublishPayload } from '@/composables/usePublish';
import Modal from '@/components/common/Modal.vue';
import StatusComposer from '@/components/status/StatusComposer.vue';

const auth = useAuthStore();
const ui = useUiStore();
const composeStore = useComposeStore();
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

async function handleGlobalCompose(payload: PublishPayload) {
  if (!auth.isAuthenticated) return;
  await publish(payload);
}

function handleModalClose() {
  ui.closeComposeModal();
  composeStore.reset();
}
</script>

<template>
  <NuxtPage />

  <Modal :open="ui.composeModalOpen" :title="$t('compose.title')" @close="handleModalClose">
    <StatusComposer :reply-to="composeReplyContext" @submit="handleGlobalCompose" />
  </Modal>
</template>
