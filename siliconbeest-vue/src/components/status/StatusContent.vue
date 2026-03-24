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
  let result = html
  for (const emoji of emojis) {
    const pattern = new RegExp(`:${emoji.shortcode}:`, 'g')
    result = result.replace(
      pattern,
      `<img src="${emoji.url}" alt=":${emoji.shortcode}:" title=":${emoji.shortcode}:" class="custom-emoji" draggable="false" />`
    )
  }
  return result
}

/**
 * Enrich mention links to always show @username@domain for remote users.
 * Remote servers often send `<a href="https://remote.server/@user">@<span>user</span></a>`
 * which only shows @user. We extract the domain from href and append it.
 */
function enrichMentions(html: string): string {
  // Match mention links: <a href="https://domain/@user" class="...mention...">@<span>username</span></a>
  return html.replace(
    /<a\s+([^>]*class="[^"]*mention[^"]*"[^>]*)href="(https?:\/\/([^/]+)\/@([^"]+))"([^>]*)>@<span>([^<]+)<\/span><\/a>/gi,
    (match, pre, href, domain, _pathUser, post, displayName) => {
      // Check if the display already includes @domain
      if (displayName.includes('@')) return match
      // Check if this is our own domain
      const currentDomain = window.location.hostname
      if (domain === currentDomain) return match
      // Append @domain to the display
      return `<a ${pre}href="${href}"${post}>@<span>${displayName}@${domain}</span></a>`
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
</style>
