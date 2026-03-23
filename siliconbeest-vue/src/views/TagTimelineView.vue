<script setup lang="ts">
defineProps<{ tag: string }>();
</script>

<template>
  <div class="max-w-2xl mx-auto">
    <h1 class="text-2xl font-bold mb-4">#{{ tag }}</h1>
  </div>
</template>
