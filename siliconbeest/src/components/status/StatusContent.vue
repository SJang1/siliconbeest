<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { emojifyHtml } from '@/utils/customEmoji'

const { t } = useI18n()

const props = defineProps<{
  content: string
  spoilerText?: string
  sensitive?: boolean
  emojis?: Array<{ shortcode: string; url: string; static_url: string }>
  hideQuoteInline?: boolean
}>()

const revealed = ref(false)

/**
 * Enrich mention links:
 * 1. Rewrite href to point to our server's profile page (/@user@domain)
 * 2. Show @username@domain for remote users
 */
function enrichMentions(html: string): string {
  if (typeof window === 'undefined') return html

  const currentDomain = window.location.hostname
  const currentOrigin = window.location.origin

  // Match mention links with class="mention" and href to any server
  // Handles both: href before class, and class before href
  return html.replace(
    /<a\s+([^>]*?)href="(https?:\/\/([^/]+)\/@([^"]+))"([^>]*?)class="([^"]*mention[^"]*)"([^>]*)>@<span>([^<]+)<\/span><\/a>/gi,
    (_match, pre, _href, domain, pathUser, mid, cls, post, displayName) => {
      const username = pathUser
      const isLocal = domain === currentDomain

      // Build our local profile URL
      const localHref = isLocal
        ? `${currentOrigin}/@${username}`
        : `${currentOrigin}/@${username}@${domain}`

      // Display name: append @domain for remote users
      const display = isLocal || displayName.includes('@')
        ? displayName
        : `${displayName}@${domain}`

      return `<a ${pre}href="${localHref}"${mid}class="${cls}"${post}>@<span>${display}</span></a>`
    }
  ).replace(
    // Also handle: class before href pattern
    /<a\s+([^>]*?)class="([^"]*mention[^"]*)"([^>]*?)href="(https?:\/\/([^/]+)\/@([^"]+))"([^>]*)>@<span>([^<]+)<\/span><\/a>/gi,
    (_match, pre, cls, mid, _href, domain, pathUser, post, displayName) => {
      const username = pathUser
      const isLocal = domain === currentDomain

      const localHref = isLocal
        ? `${currentOrigin}/@${username}`
        : `${currentOrigin}/@${username}@${domain}`

      const display = isLocal || displayName.includes('@')
        ? displayName
        : `${displayName}@${domain}`

      return `<a ${pre}class="${cls}"${mid}href="${localHref}"${post}>@<span>${display}</span></a>`
    }
  ).replace(
    // Handle mention links WITHOUT <span> wrapper (e.g. from Misskey/Pleroma/hackers.pub)
    // Pattern: <a href="https://domain/@user" class="mention">@user@domain</a>
    /<a\s+([^>]*?)href="(https?:\/\/([^/]+)\/@([^"]+))"([^>]*?)class="([^"]*mention[^"]*)"([^>]*)>@([^<]+)<\/a>/gi,
    (_match, pre, _href, domain, pathUser, mid, cls, post, displayText) => {
      const username = pathUser
      const isLocal = domain === currentDomain

      const localHref = isLocal
        ? `${currentOrigin}/@${username}`
        : `${currentOrigin}/@${username}@${domain}`

      const display = isLocal || displayText.includes('@')
        ? displayText
        : `${displayText}@${domain}`

      return `<a ${pre}href="${localHref}"${mid}class="${cls}"${post}>@<span>${display}</span></a>`
    }
  ).replace(
    // Same but class before href
    /<a\s+([^>]*?)class="([^"]*mention[^"]*)"([^>]*?)href="(https?:\/\/([^/]+)\/@([^"]+))"([^>]*)>@([^<]+)<\/a>/gi,
    (_match, pre, cls, mid, _href, domain, pathUser, post, displayText) => {
      const username = pathUser
      const isLocal = domain === currentDomain

      const localHref = isLocal
        ? `${currentOrigin}/@${username}`
        : `${currentOrigin}/@${username}@${domain}`

      const display = isLocal || displayText.includes('@')
        ? displayText
        : `${displayText}@${domain}`

      return `<a ${pre}class="${cls}"${mid}href="${localHref}"${post}>@<span>${display}</span></a>`
    }
  )
}

function stripQuoteInline(html: string): string {
  if (!props.hideQuoteInline || typeof document === 'undefined') return html
  const template = document.createElement('template')
  template.innerHTML = html
  template.content.querySelectorAll('.quote-inline').forEach((node) => node.remove())
  return template.innerHTML
}

const processedContent = computed(() => stripQuoteInline(emojifyHtml(enrichMentions(props.content), props.emojis)))
const processedSpoiler = computed(() => emojifyHtml(enrichMentions(props.spoilerText || ''), props.emojis))
</script>

<template>
  <div class="status-content mt-1">
    <!-- CW / Spoiler -->
    <div v-if="spoilerText">
      <p class="text-sm font-medium text-slate-700 dark:text-slate-300" v-html="processedSpoiler" />
      <button
        @click="revealed = !revealed"
        class="mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1 text-xs font-semibold text-slate-600 transition-colors hover:bg-brand-50 hover:text-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 dark:bg-surface-2-dark dark:text-slate-300 dark:hover:bg-brand-950/60 dark:hover:text-brand-300"
        :aria-expanded="revealed"
      >
        <svg v-if="revealed" class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" /></svg>
        <svg v-else class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
        {{ revealed ? t('status.show_less') : t('status.show_more') }}
      </button>
    </div>

    <!-- Content (hidden behind CW if spoiler_text present) -->
    <div
      v-if="!spoilerText || revealed"
      class="prose prose-sm mt-1 max-w-none break-words leading-relaxed dark:prose-invert"
      v-html="processedContent"
    />
  </div>
</template>
