import { usePublicInstance } from '@/composables/usePublicInstance';

export default defineNuxtPlugin({
  name: 'public-instance',
  dependsOn: ['pinia'],
  async setup() {
    // Navigation feature flags (including AI recommendations) must be ready
    // before SSR renders. useAsyncData also transfers this response to the
    // client payload, keeping hydration markup identical without a refetch.
    await usePublicInstance();
  },
});
