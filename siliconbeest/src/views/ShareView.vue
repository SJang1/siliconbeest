<script setup lang="ts">
import { onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUiStore } from '@/stores/ui'
import { withCurrentDesign } from '@/utils/safeRedirect'

// Mastodon-compatible share intent: /share?text=...&url=...&title=...
// Auth is enforced by route middleware/guards, so by the time this mounts
// the user is logged in. Open the global composer prefilled and settle on
// the home timeline behind it.

const route = useRoute()
const router = useRouter()
const ui = useUiStore()

function firstQueryValue(value: unknown): string {
  const candidate = Array.isArray(value) ? value[0] : value
  return typeof candidate === 'string' ? candidate : ''
}

onMounted(() => {
  const title = firstQueryValue(route.query.title).trim()
  const text = firstQueryValue(route.query.text).trim()
  const url = firstQueryValue(route.query.url).trim()
  const prefillText = [title, text, url].filter(Boolean).join('\n\n')

  ui.openComposeModal(prefillText ? { prefillText } : undefined)
  void router.replace(withCurrentDesign('/home', route.path))
})
</script>

<template>
  <div class="flex min-h-dvh items-center justify-center">
    <svg class="h-8 w-8 animate-spin text-gray-400" fill="none" viewBox="0 0 24 24" role="status" :aria-label="$t('common.loading')">
      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
      <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
    </svg>
  </div>
</template>
