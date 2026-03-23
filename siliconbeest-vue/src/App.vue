<script setup lang="ts">
import { onMounted } from 'vue';
import { RouterView } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { useInstanceStore } from '@/stores/instance';

const auth = useAuthStore();
const instance = useInstanceStore();

onMounted(async () => {
  // Load instance info and verify credentials in parallel
  const promises: Promise<void>[] = [instance.init()];
  if (auth.isAuthenticated) {
    promises.push(auth.fetchCurrentUser());
  }
  await Promise.allSettled(promises);
});
</script>

<template>
  <RouterView />
</template>
