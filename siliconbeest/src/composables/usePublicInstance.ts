import { watchEffect } from 'vue';
import { useAsyncData, useRequestFetch } from '#imports';
import { useInstanceStore } from '@/stores/instance';
import type { Instance } from '@/types/mastodon';

export async function usePublicInstance() {
  const instanceStore = useInstanceStore();
  const requestFetch = useRequestFetch();

  const asyncData = await useAsyncData<Instance | null>('public-instance', async () => {
    try {
      return await requestFetch<Instance>('/api/v2/instance');
    } catch {
      return null;
    }
  }, {
    default: () => instanceStore.instance,
  });

  watchEffect(() => {
    if (asyncData.data.value) {
      instanceStore.instance = asyncData.data.value;
    }
  });

  return asyncData;
}
