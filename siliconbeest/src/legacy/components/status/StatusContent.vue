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
      <p class="text-sm text-gray-700 dark:text-gray-300" v-html="processedSpoiler" />
      <button
        @click="revealed = !revealed"
        class="mt-1 px-3 py-1 text-xs font-semibold rounded bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
        :aria-expanded="revealed"
      >
        {{ revealed ? t('status.show_less') : t('status.show_more') }}
      </button>
    </div>

    <!-- Content (hidden behind CW if spoiler_text present) -->
    <div
      v-if="!spoilerText || revealed"
      class="prose prose-sm dark:prose-invert max-w-none mt-1 break-words"
      v-html="processedContent"
    />
  </div>
</template>
