<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const props = defineProps<{
  content: string
  spoilerText?: string
  sensitive?: boolean
  emojis?: Array<{ shortcode: string; url: string; static_url: string }>
}>()

const revealed = ref(false)

/** Replace :shortcode: patterns with <img> tags using the emojis array */
function emojify(html: string, emojis?: Array<{ shortcode: string; url: string; static_url: string }>): string {
  if (!emojis || emojis.length === 0) return html
  // Deduplicate by shortcode
  const seen = new Set<string>()
  const unique = emojis.filter(e => { if (seen.has(e.shortcode)) return false; seen.add(e.shortcode); return true })
  let result = html
  for (const emoji of unique) {
    const escaped = emoji.shortcode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // Match :shortcode: with optional zero-width spaces, but NOT inside HTML attributes (after =")
    result = result.replace(
      new RegExp(`(?<!=")\\u200B?:${escaped}:\\u200B?`, 'g'),
      `<img src="${emoji.url}" alt="${emoji.shortcode}" title="${emoji.shortcode}" class="custom-emoji" draggable="false" onerror="this.replaceWith(document.createTextNode(':${emoji.shortcode}:'))" />`
    )
  }
  return result
}

/**
 * Enrich mention links:
 * 1. Rewrite href to point to our server's profile page (/@user@domain)
 * 2. Show @username@domain for remote users
 */
function enrichMentions(html: string): string {
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

const processedContent = computed(() => emojify(enrichMentions(props.content), props.emojis))
const processedSpoiler = computed(() => emojify(enrichMentions(props.spoilerText || ''), props.emojis))
</script>

<template>
  <div class="mt-1">
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

<style scoped>
:deep(.custom-emoji) {
  display: inline;
  height: 1.2em;
  width: auto;
  vertical-align: middle;
  margin: 0 0.05em;
}

/* Ensure paragraph spacing for \n\n line breaks */
:deep(p) {
  margin-bottom: 0.75em;
}
:deep(p:last-child) {
  margin-bottom: 0;
}

/* Links styling */
:deep(a) {
  color: rgb(99 102 241);
  text-decoration: none;
}
:deep(a:hover) {
  text-decoration: underline;
}

/* Mastodon-style link formatting (remote status HTML)
   Override Tailwind's .invisible (visibility:hidden) which keeps layout space */
:deep(.invisible) {
  font-size: 0 !important;
  line-height: 0 !important;
  display: inline-block !important;
  width: 0 !important;
  height: 0 !important;
  position: absolute !important;
  visibility: visible !important;
  overflow: hidden !important;
}
:deep(.ellipsis::after) {
  content: "…";
}
</style>
