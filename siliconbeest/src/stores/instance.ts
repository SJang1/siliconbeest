import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { Instance, CustomEmoji } from '@/types/mastodon';
import { getInstance, getCustomEmojis } from '@/api/mastodon/instance';

export const useInstanceStore = defineStore('instance', () => {
  const instance = ref<Instance | null>(null);
  const customEmojis = ref<CustomEmoji[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function fetchInstance() {
    loading.value = true;
    error.value = null;
    try {
      const { data } = await getInstance();
      instance.value = data;
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      loading.value = false;
    }
  }

  async function fetchCustomEmojis() {
    try {
      const { data } = await getCustomEmojis();
      customEmojis.value = data;
    } catch {
      // Non-critical, silently fail
    }
  }

  async function init() {
    await Promise.all([fetchInstance(), fetchCustomEmojis()]);
  }

  return {
    instance,
    customEmojis,
    loading,
    error,
    fetchInstance,
    fetchCustomEmojis,
    init,
  };
});
