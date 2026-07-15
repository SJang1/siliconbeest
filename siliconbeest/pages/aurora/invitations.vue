<script setup lang="ts">
import AppShell from '@/components/layout/AppShell.vue'
import SettingsInvitationsView from '@/views/SettingsInvitationsView.vue'

definePageMeta({ name: 'aurora-invitations' })
</script>

<template>
  <AppShell>
    <main class="mx-auto min-h-full w-full max-w-4xl px-4 py-6">
      <SettingsInvitationsView />
    </main>
  </AppShell>
</template>
