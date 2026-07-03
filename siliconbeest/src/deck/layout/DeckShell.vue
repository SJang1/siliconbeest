<script setup lang="ts">
import DeckTopBar from './DeckTopBar.vue'
import DeckRail from './DeckRail.vue'
import DeckMobileNav from './DeckMobileNav.vue'
</script>

<template>
  <div class="dk-app flex h-dvh flex-col overflow-hidden">
    <DeckTopBar />
    <div class="flex min-h-0 flex-1">
      <DeckRail class="hidden md:flex" />
      <main class="min-h-0 min-w-0 flex-1">
        <slot />
      </main>
    </div>
    <DeckMobileNav class="md:hidden" />
  </div>
</template>
