<script setup lang="ts">
import { computed, ref } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { useComposeStore } from '@/stores/compose';
import { usePublish, type PublishPayload } from '@/composables/usePublish';
import Modal from '@/components/common/Modal.vue';
import StatusComposer from '@/components/status/StatusComposer.vue';
import LegacyModal from '@/legacy/components/common/Modal.vue';
import LegacyStatusComposer from '@/legacy/components/status/StatusComposer.vue';
import {
  isOldDesignPath,
  isAuroraDesignPath,
  toDeckPath,
} from '@/utils/designVersion';

const auth = useAuthStore();
const ui = useUiStore();
const composeStore = useComposeStore();
const { publish } = usePublish();
const route = useRoute();

// Classic design lives under /old/*; keep its global overlays on the old look.
const isOldDesign = computed(() => isOldDesignPath(route.path));
const newDesignUrl = computed(() => toDeckPath(route.fullPath));

// Canonical routes render the Deck design. The dk-app class on <body>
// activates the Deck token/skin layer (deck.css) everywhere on those
// routes — including teleported overlays — while /old/* and /aurora/*
// keep their own looks.
const isDeckDesign = computed(
  () => !isOldDesignPath(route.path) && !isAuroraDesignPath(route.path),
);
useHead({
  bodyAttrs: {
    class: computed(() => (isDeckDesign.value ? 'dk-app' : '')),
  },
});

const BANNER_DISMISSED_KEY = 'siliconbeest_classic_banner_dismissed';
const bannerDismissed = ref(
  import.meta.client && sessionStorage.getItem(BANNER_DISMISSED_KEY) === '1',
);

function dismissBanner() {
  bannerDismissed.value = true;
  if (import.meta.client) sessionStorage.setItem(BANNER_DISMISSED_KEY, '1');
}

// Aurora design lives under /aurora/*; offer the way back to Deck.
const isAuroraDesign = computed(() => isAuroraDesignPath(route.path));
const deckDesignUrl = computed(() => toDeckPath(route.fullPath));

const AURORA_BANNER_DISMISSED_KEY = 'siliconbeest_aurora_banner_dismissed';
const auroraBannerDismissed = ref(
  import.meta.client && sessionStorage.getItem(AURORA_BANNER_DISMISSED_KEY) === '1',
);

function dismissAuroraBanner() {
  auroraBannerDismissed.value = true;
  if (import.meta.client) sessionStorage.setItem(AURORA_BANNER_DISMISSED_KEY, '1');
}

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

  <component
    :is="isOldDesign ? LegacyModal : Modal"
    :open="ui.composeModalOpen"
    :title="$t('compose.title')"
    @close="handleModalClose"
  >
    <component
      :is="isOldDesign ? LegacyStatusComposer : StatusComposer"
      :reply-to="composeReplyContext"
      :initial-text="ui.composePrefillText || undefined"
      @submit="handleGlobalCompose"
    />
  </component>

  <Transition name="fade">
    <div
      v-if="isOldDesign && !bannerDismissed"
      class="fixed bottom-20 md:bottom-6 left-1/2 z-40 flex w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-full bg-gray-900/90 px-4 py-2 text-sm text-white shadow-lg backdrop-blur dark:bg-white/90 dark:text-gray-900"
    >
      <span class="truncate">{{ $t('design.classicBanner') }}</span>
      <a
        :href="newDesignUrl"
        class="shrink-0 font-semibold text-white underline dark:text-gray-900"
        >{{ $t('design.switchToNew') }}</a
      >
      <button
        type="button"
        class="shrink-0 opacity-70 hover:opacity-100"
        :aria-label="$t('common.close')"
        @click="dismissBanner"
      >
        ✕
      </button>
    </div>
  </Transition>

  <Transition name="fade">
    <div
      v-if="isAuroraDesign && !auroraBannerDismissed"
      class="fixed bottom-20 md:bottom-6 left-1/2 z-40 flex w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-full bg-gray-900/90 px-4 py-2 text-sm text-white shadow-lg backdrop-blur dark:bg-white/90 dark:text-gray-900"
    >
      <span class="truncate">{{ $t('design.auroraBanner') }}</span>
      <a
        :href="deckDesignUrl"
        class="shrink-0 font-semibold text-white underline dark:text-gray-900"
        >{{ $t('design.switchToNew') }}</a
      >
      <button
        type="button"
        class="shrink-0 opacity-70 hover:opacity-100"
        :aria-label="$t('common.close')"
        @click="dismissAuroraBanner"
      >
        ✕
      </button>
    </div>
  </Transition>
</template>
