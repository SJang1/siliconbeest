<script setup lang="ts">
import DeckTopBar from './DeckTopBar.vue'
import DeckRail from './DeckRail.vue'
import DeckMobileNav from './DeckMobileNav.vue'
import AnnouncementBanner from '@/components/common/AnnouncementBanner.vue'

defineProps<{
  showMobileDeck?: boolean
}>()
</script>

<template>
  <div class="dk-app flex h-dvh flex-col overflow-hidden">
    <DeckTopBar />
    <AnnouncementBanner />
    <div class="flex min-h-0 flex-1">
      <DeckRail class="hidden md:flex" :show-mobile-deck="showMobileDeck" />
      <main class="min-h-0 min-w-0 flex-1">
        <slot />
      </main>
    </div>
    <DeckMobileNav class="md:hidden" />
  </div>
</template>
