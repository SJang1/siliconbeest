<script setup lang="ts">
import { onMounted } from 'vue';
import { RouterView, useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { useInstanceStore } from '@/stores/instance';
import { useUiStore } from '@/stores/ui';
import { useComposeStore } from '@/stores/compose';
import { useTimelinesStore } from '@/stores/timelines';
import Modal from '@/components/common/Modal.vue';
import StatusComposer from '@/components/status/StatusComposer.vue';

const auth = useAuthStore();
const instance = useInstanceStore();
const ui = useUiStore();
const compose = useComposeStore();
const timelinesStore = useTimelinesStore();
const router = useRouter();

async function handleGlobalCompose(payload: { content: string; visibility?: string; spoiler_text?: string; language?: string }) {
  if (!auth.token) return;
  compose.text = payload.content;
  if (payload.visibility) compose.visibility = payload.visibility as any;
  if (payload.spoiler_text) {
    compose.contentWarning = payload.spoiler_text;
    compose.showContentWarning = true;
  }
  if (payload.language) compose.language = payload.language;
  const status = await compose.publish();
  if (status) {
    timelinesStore.prependStatus('home', status.id);
    ui.closeComposeModal();
  }
}

onMounted(async () => {
  // Load instance info and verify credentials in parallel
  const promises: Promise<void>[] = [instance.init()];
  if (auth.isAuthenticated) {
    promises.push(auth.fetchCurrentUser());
  }
  await Promise.allSettled(promises);

  // Set dynamic page title
  document.title = instance.instance?.title || 'SiliconBeest';

  // Set dynamic favicon
  const faviconUrl = instance.instance?.thumbnail?.url;
  if (faviconUrl) {
    let link = document.querySelector("link[rel='icon']") as HTMLLinkElement;
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.href = faviconUrl;
  }
});
</script>

<template>
  <RouterView />

  <!-- Global compose modal -->
  <Modal :open="ui.composeModalOpen" @close="ui.closeComposeModal()">
    <div class="bg-white dark:bg-gray-900 rounded-2xl w-[90vw] sm:w-[600px] lg:w-[640px] mx-auto">
      <div class="flex items-center justify-between px-4 pt-4 pb-2">
        <h2 class="text-lg font-bold">{{ $t('compose.title') }}</h2>
        <button
          @click="ui.closeComposeModal()"
          class="p-1 rounded-full hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500"
        >
          ✕
        </button>
      </div>
      <StatusComposer @submit="handleGlobalCompose" />
    </div>
  </Modal>
</template>
