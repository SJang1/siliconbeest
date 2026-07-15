<script setup lang="ts">
import DeckPageShell from '@/deck/layout/DeckPageShell.vue'
import SettingsInvitationsView from '@/views/SettingsInvitationsView.vue'

definePageMeta({ name: 'invitations' })
</script>

<template>
  <DeckPageShell width="wide">
    <div class="min-h-full px-3 py-4 md:px-0">
      <SettingsInvitationsView />
    </div>
  </DeckPageShell>
</template>
