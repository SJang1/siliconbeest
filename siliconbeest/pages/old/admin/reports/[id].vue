<script setup lang="ts">
import AdminReportDetailView from '@/legacy/views/AdminReportDetailView.vue';

definePageMeta({ name: 'old-admin-report-detail' });

const route = useRoute();
const id = computed(() => String(route.params.id));
</script>

<template>
  <AdminReportDetailView :id="id" />
</template>
