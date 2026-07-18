<script setup lang="ts">
import { ref, computed, nextTick, watch, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Listbox, ListboxButton, ListboxOptions, ListboxOption } from '@headlessui/vue'
import { useComposeStore } from '@/stores/compose'
import { useEmojis } from '@/composables/useEmojis'
import { search as apiSearch } from '@/api/mastodon/search'
import { useAuthStore } from '@/stores/auth'
import EmojiPicker from '@/legacy/components/common/EmojiPicker.vue'
import { articleMediaMarkdown } from '@/utils/markdownMedia'
import type { MediaAttachment } from '@/types/mastodon'

const { t } = useI18n()
const compose = useComposeStore()
const auth = useAuthStore()
const { fetchCustomEmojis, searchEmojis } = useEmojis()

const props = defineProps<{
  replyTo?: { id: string; account: { acct: string }; mentions?: Array<{ acct: string }>; visibility?: string }
  maxChars?: number
}>()

const emit = defineEmits<{
  submit: [payload: {
    content: string
    object_type: 'Note' | 'Article'
    title?: string
    summary?: string
    spoiler_text: string
    visibility: string
    language: string
    in_reply_to_id?: string
    quote_id?: string
    quote_policy?: import('@/types/mastodon').QuotePolicy
    media_ids?: string[]
  }]
}>()

const isEditing = computed(() => compose.editingId !== null)
const content = ref(isEditing.value ? compose.text : '')
const objectType = ref<'Note' | 'Article'>(isEditing.value ? compose.objectType : 'Note')
const articleTitle = ref(isEditing.value ? compose.title : '')
const articleSummary = ref(isEditing.value ? compose.articleSummary : '')
const spoilerText = ref(isEditing.value ? compose.contentWarning : '')
const showCw = ref(isEditing.value ? compose.showContentWarning : false)
const fileInput = ref<HTMLInputElement | null>(null)
const textareaRef = ref<HTMLTextAreaElement | null>(null)
const charLimit = computed(() => objectType.value === 'Article' ? 100_000 : (props.maxChars ?? 500))
const charsRemaining = computed(() => charLimit.value - content.value.length)

// ── Emoji picker state ──────────────────────────────────────────────
const showEmojiPicker = ref(false)
const emojiPickerRef = ref<HTMLElement | null>(null)
const emojiButtonRef = ref<HTMLElement | null>(null)

/** Position the emoji picker above the button, teleported to body */
const emojiPickerPosition = computed(() => {
  if (!emojiButtonRef.value) return { top: '0px', left: '0px' }
  const rect = emojiButtonRef.value.getBoundingClientRect()
  const pickerHeight = 340 // max-h-80 = 320 + some margin
  const pickerWidth = 288 // w-72

  // Try above the button first
  let top = rect.top - pickerHeight
  if (top < 8) top = rect.bottom + 4 // Fall back to below if no space above

  let left = rect.right - pickerWidth
  if (left < 8) left = 8

  return { top: `${top}px`, left: `${left}px` }
})

onMounted(() => {
  fetchCustomEmojis()
  document.addEventListener('click', handleClickOutside)

  // Auto-populate mentions when replying
  if (props.replyTo) {
    populateReplyMentions(props.replyTo)
  }
})

/** Extract @user@domain mentions from HTML content by parsing mention links */
function extractMentionsFromContent(htmlContent?: string): string[] {
  if (!htmlContent) return []
  const results: string[] = []
  const currentDomain = window.location.hostname
  // Match: <a href="https://domain/@username" class="...mention...">
  const regex = /href="https?:\/\/([^/]+)\/@([^"]+)"[^>]*class="[^"]*mention/gi
  let match
  while ((match = regex.exec(htmlContent)) !== null) {
    const domain = match[1]
    const username = match[2]
    if (!username) continue
    if (domain === currentDomain) {
      results.push(username) // local user
    } else {
      results.push(`${username}@${domain}`)
    }
  }
  return results
}

/** Populate reply mentions from status data */
function populateReplyMentions(replyTo: typeof props.replyTo) {
  if (!replyTo) return
  const myAcct = auth.currentUser?.acct
  const seen = new Set<string>()
  const mentions: string[] = []

  function addMention(acct: string) {
    const normalized = acct.replace(/^@/, '')
    if (normalized === myAcct || seen.has(normalized)) return
    seen.add(normalized)
    mentions.push(`@${normalized}`)
  }

  // 1. Author of the post
  addMention(replyTo.account.acct)

  // 2. Mentions from API response
  if (replyTo.mentions) {
    for (const m of replyTo.mentions) addMention(m.acct)
  }

  // 3. Mentions extracted from HTML content (catches ones missing from mentions array)
  const contentMentions = extractMentionsFromContent((replyTo as any).content)
  for (const acct of contentMentions) addMention(acct)

  if (mentions.length > 0) {
    content.value = mentions.join(' ') + ' '
    nextTick(() => {
      if (textareaRef.value) {
        textareaRef.value.focus()
        textareaRef.value.selectionStart = content.value.length
        textareaRef.value.selectionEnd = content.value.length
      }
    })
  }
}

// When reply target changes
watch(() => props.replyTo?.id, (newId, oldId) => {
  if (!newId || newId === oldId) return
  populateReplyMentions(props.replyTo)
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
})

function handleClickOutside(e: MouseEvent) {
  if (showEmojiPicker.value && emojiPickerRef.value && !emojiPickerRef.value.contains(e.target as Node)) {
    showEmojiPicker.value = false
  }
  if (autocompleteVisible.value && autocompleteRef.value && !autocompleteRef.value.contains(e.target as Node)) {
    closeAutocomplete()
  }
}

function toggleEmojiPicker() {
  showEmojiPicker.value = !showEmojiPicker.value
}

function onEmojiSelect(emoji: string) {
  insertAtCursor(emoji)
  showEmojiPicker.value = false
}

function insertAtCursor(text: string) {
  const ta = textareaRef.value
  if (!ta) {
    content.value += text
    return
  }
  const start = ta.selectionStart ?? content.value.length
  const end = ta.selectionEnd ?? content.value.length
  const before = content.value.substring(0, start)
  const after = content.value.substring(end)
  content.value = before + text + after
  nextTick(() => {
    const pos = start + text.length
    ta.selectionStart = pos
    ta.selectionEnd = pos
    ta.focus()
  })
}

function insertArticleMedia(media: MediaAttachment, fileName?: string) {
  const ta = textareaRef.value
  const start = ta?.selectionStart ?? content.value.length
  const end = ta?.selectionEnd ?? content.value.length
  const before = content.value.substring(0, start)
  const after = content.value.substring(end)
  const prefix = before.length > 0 && !before.endsWith('\n') ? '\n\n' : ''
  const suffix = after.length > 0 && !after.startsWith('\n') ? '\n\n' : ''
  const markdown = `${prefix}${articleMediaMarkdown(media, fileName)}${suffix}`
  content.value = before + markdown + after
  nextTick(() => {
    if (!ta) return
    const pos = start + markdown.length
    ta.selectionStart = pos
    ta.selectionEnd = pos
    ta.focus()
  })
  compose.removeMedia(media.id)
}

async function addComposerMedia(file: File) {
  const media = await compose.addMedia(file)
  if (media && objectType.value === 'Article') {
    insertArticleMedia(media, file.name)
  }
}

// ── Autocomplete state ──────────────────────────────────────────────
const autocompleteRef = ref<HTMLElement | null>(null)
const autocompleteVisible = ref(false)
const autocompleteType = ref<'emoji' | 'mention' | 'hashtag'>('emoji')
const autocompleteQuery = ref('')
const autocompleteIndex = ref(0)
const autocompleteItems = ref<Array<{
  key: string
  label: string
  sublabel?: string
  image?: string
  value: string
}>>([])

let debounceTimer: ReturnType<typeof setTimeout> | null = null

function closeAutocomplete() {
  autocompleteVisible.value = false
  autocompleteItems.value = []
  autocompleteIndex.value = 0
  autocompleteQuery.value = ''
}

function onTextareaInput() {
  detectAutocomplete()
}

function detectAutocomplete() {
  const ta = textareaRef.value
  if (!ta) return
  const cursor = ta.selectionStart ?? 0
  const textBefore = content.value.substring(0, cursor)

  // Match :shortcode (2+ chars after :)
  const emojiMatch = textBefore.match(/:([a-zA-Z0-9_]{2,})$/)
  if (emojiMatch) {
    autocompleteType.value = 'emoji'
    autocompleteQuery.value = emojiMatch[1]!
    autocompleteIndex.value = 0
    runEmojiSearch(emojiMatch[1]!)
    return
  }

  // Match @mention (2+ chars after @)
  const mentionMatch = textBefore.match(/@([a-zA-Z0-9_]{2,})$/)
  if (mentionMatch) {
    autocompleteType.value = 'mention'
    autocompleteQuery.value = mentionMatch[1]!
    autocompleteIndex.value = 0
    debouncedApiSearch(mentionMatch[1]!, 'accounts')
    return
  }

  // Match #hashtag (2+ chars after #)
  const hashtagMatch = textBefore.match(/#([a-zA-Z0-9_\u{AC00}-\u{D7AF}]{2,})$/u)
  if (hashtagMatch) {
    autocompleteType.value = 'hashtag'
    autocompleteQuery.value = hashtagMatch[1]!
    autocompleteIndex.value = 0
    debouncedApiSearch(hashtagMatch[1]!, 'hashtags')
    return
  }

  closeAutocomplete()
}

function runEmojiSearch(query: string) {
  const results = searchEmojis(query)
  const items: typeof autocompleteItems.value = []

  for (const e of results.custom.slice(0, 8)) {
    items.push({
      key: `custom:${e.shortcode}`,
      label: e.shortcode,
      image: e.static_url,
      value: `:${e.shortcode}: `,
    })
  }
  for (const e of results.unicode.slice(0, 4)) {
    items.push({
      key: `unicode:${e.name}`,
      label: `${e.emoji} ${e.name}`,
      value: `${e.emoji} `,
    })
  }

  autocompleteItems.value = items
  autocompleteVisible.value = items.length > 0
}

function debouncedApiSearch(query: string, type: 'accounts' | 'hashtags') {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    performApiSearch(query, type)
  }, 200)
}

async function performApiSearch(query: string, type: 'accounts' | 'hashtags') {
  if (!auth.token) return
  try {
    const { data } = await apiSearch(query, { type, limit: 8, token: auth.token })
    const items: typeof autocompleteItems.value = []

    if (type === 'accounts') {
      for (const account of data.accounts) {
        items.push({
          key: `account:${account.id}`,
          label: account.display_name || account.username,
          sublabel: `@${account.acct}`,
          image: account.avatar,
          value: `@${account.acct} `,
        })
      }
    } else {
      for (const tag of data.hashtags) {
        items.push({
          key: `tag:${tag.name}`,
          label: `#${tag.name}`,
          value: `#${tag.name} `,
        })
      }
    }

    autocompleteItems.value = items
    autocompleteVisible.value = items.length > 0
  } catch {
    // Silently fail
  }
}

function selectAutocompleteItem(item: typeof autocompleteItems.value[0]) {
  if (!item) return
  const ta = textareaRef.value
  if (!ta) return

  const cursor = ta.selectionStart ?? content.value.length
  const textBefore = content.value.substring(0, cursor)
  const textAfter = content.value.substring(cursor)

  // Find the trigger position to replace
  let triggerPos = cursor
  if (autocompleteType.value === 'emoji') {
    triggerPos = textBefore.lastIndexOf(':')
  } else if (autocompleteType.value === 'mention') {
    triggerPos = textBefore.lastIndexOf('@')
  } else if (autocompleteType.value === 'hashtag') {
    triggerPos = textBefore.lastIndexOf('#')
  }

  const before = content.value.substring(0, triggerPos)
  content.value = before + item.value + textAfter

  closeAutocomplete()

  nextTick(() => {
    const pos = triggerPos + item.value.length
    ta.selectionStart = pos
    ta.selectionEnd = pos
    ta.focus()
  })
}

function onTextareaKeydown(e: KeyboardEvent) {
  if (!autocompleteVisible.value) return

  if (e.key === 'ArrowDown') {
    e.preventDefault()
    autocompleteIndex.value = Math.min(autocompleteIndex.value + 1, autocompleteItems.value.length - 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    autocompleteIndex.value = Math.max(autocompleteIndex.value - 1, 0)
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    if (autocompleteItems.value[autocompleteIndex.value]) {
      e.preventDefault()
      selectAutocompleteItem(autocompleteItems.value[autocompleteIndex.value]!)
    }
  } else if (e.key === 'Escape') {
    e.preventDefault()
    closeAutocomplete()
  }
}

// ── Original composer logic ─────────────────────────────────────────
const languageOptions = [
  { code: 'ko', label: '한국어' },
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
  { code: 'zh', label: '中文' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'pt', label: 'Português' },
  { code: 'ru', label: 'Русский' },
  { code: 'ar', label: 'العربية' },
]
const selectedLanguage = ref(
  languageOptions.find(l => l.code === (
    typeof navigator === 'undefined' ? 'en' : (navigator.language?.split('-')[0] || 'en')
  )) || languageOptions[1]!
)

const visibilityOptions = [
  { value: 'public', label: 'compose.visibility.public', icon: '🌐' },
  { value: 'unlisted', label: 'compose.visibility.unlisted', icon: '🔓' },
  { value: 'private', label: 'compose.visibility.private', icon: '🔒' },
  { value: 'direct', label: 'compose.visibility.direct', icon: '✉️' },
]

const VISIBILITY_RANK: Record<string, number> = { direct: 0, private: 1, unlisted: 2, public: 3 }

function initialVisibility() {
  const defaultOpt = visibilityOptions.find(o => o.value === compose.defaultVisibility) ?? visibilityOptions[0]!
  if (props.replyTo?.visibility) {
    // Clamp: can't be more public than the parent
    const parentRank = VISIBILITY_RANK[props.replyTo.visibility] ?? 3
    const defaultRank = VISIBILITY_RANK[defaultOpt.value] ?? 3
    if (defaultRank > parentRank) {
      return visibilityOptions.find(o => o.value === props.replyTo!.visibility) ?? defaultOpt
    }
  }
  return defaultOpt
}

const selectedVisibility = ref(initialVisibility())
const quotePolicyOptions: Array<{ value: import('@/types/mastodon').QuotePolicy; label: string }> = [
  { value: 'public', label: 'compose.quote_policy.public' },
  { value: 'followers', label: 'compose.quote_policy.followers' },
  { value: 'nobody', label: 'compose.quote_policy.nobody' },
]
const quotePolicyIcons: Record<import('@/types/mastodon').QuotePolicy, string> = {
  public: '↗',
  followers: '◎',
  nobody: '⊘',
}

function loadEditingDraft() {
  if (!compose.editingId) return
  content.value = compose.text
  objectType.value = compose.objectType
  articleTitle.value = compose.title
  articleSummary.value = compose.articleSummary
  spoilerText.value = compose.contentWarning
  showCw.value = compose.showContentWarning
  selectedVisibility.value = visibilityOptions.find(option => option.value === compose.visibility)
    ?? visibilityOptions[0]!
  selectedLanguage.value = languageOptions.find(option => option.code === compose.language)
    ?? languageOptions[1]!
}

watch(() => compose.editingId, (editingId) => {
  if (editingId) {
    loadEditingDraft()
  } else {
    content.value = ''
    objectType.value = 'Note'
    articleTitle.value = ''
    articleSummary.value = ''
    spoilerText.value = ''
    showCw.value = false
  }
}, { immediate: true })

const canSubmit = computed(() => {
  const hasContent = content.value.trim().length > 0 || compose.mediaAttachments.length > 0 || !!compose.quoteStatus
  const validTitle = objectType.value !== 'Article'
    || (articleTitle.value.trim().length > 0 && articleTitle.value.length <= 200)
  return hasContent && validTitle && charsRemaining.value >= 0 && !compose.uploading
})

async function toggleArticle() {
  objectType.value = objectType.value === 'Article' ? 'Note' : 'Article'
  if (objectType.value === 'Article') {
    if (compose.showPoll) togglePoll()
    for (const media of [...compose.mediaAttachments]) {
      insertArticleMedia(media)
      await nextTick()
    }
  }
}

function togglePoll() {
  if (compose.showPoll) {
    compose.showPoll = false
    compose.pollOptions = []
  } else {
    compose.showPoll = true
    compose.pollOptions = ['', '']
  }
}

function triggerFileInput() {
  fileInput.value?.click()
}

async function onFileSelect(event: Event) {
  const input = event.target as HTMLInputElement
  if (!input.files) return

  for (const file of Array.from(input.files)) {
    if (compose.mediaAttachments.length >= 4) break
    await addComposerMedia(file)
  }

  // Reset input so the same file can be re-selected
  input.value = ''
}

// ── ALT text editor ─────────────────────────────────────────────────
const altEditMedia = ref<any>(null)
const altEditText = ref('')

function openAltEditor(media: any) {
  altEditMedia.value = media
  altEditText.value = media.description || ''
}

async function saveAlt() {
  if (!altEditMedia.value || !auth.token) return
  try {
    // Update via API
    const res = await fetch(`/api/v1/media/${altEditMedia.value.id}`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: altEditText.value }),
    })
    if (res.ok) {
      // Update local state
      altEditMedia.value.description = altEditText.value
    }
  } catch { /* ignore */ }
  altEditMedia.value = null
}

/** Handle paste events — if clipboard contains images, upload them */
async function onPaste(event: ClipboardEvent) {
  const items = event.clipboardData?.items
  if (!items) return

  for (const item of Array.from(items)) {
    if (item.type.startsWith('image/') || item.type.startsWith('video/')) {
      event.preventDefault()
      const file = item.getAsFile()
      if (file && compose.mediaAttachments.length < 4) {
        await addComposerMedia(file)
      }
    }
  }
}

/** Handle drag & drop of files */
async function onDrop(event: DragEvent) {
  const files = event.dataTransfer?.files
  if (!files) return

  for (const file of Array.from(files)) {
    if (compose.mediaAttachments.length >= 4) break
    if (file.type.startsWith('image/') || file.type.startsWith('video/') || file.type.startsWith('audio/')) {
      await addComposerMedia(file)
    }
  }
}

function submit() {
  if (!canSubmit.value) return
  emit('submit', {
    content: content.value,
    object_type: objectType.value,
    title: objectType.value === 'Article' ? articleTitle.value.trim() : undefined,
    summary: objectType.value === 'Article' ? articleSummary.value.trim() : undefined,
    spoiler_text: showCw.value ? spoilerText.value : '',
    visibility: selectedVisibility.value.value,
    language: selectedLanguage.value.code,
    in_reply_to_id: props.replyTo?.id,
    quote_id: compose.quoteId ?? undefined,
    quote_policy: compose.quotePolicy,
    media_ids: compose.mediaAttachments.map(m => m.id),
  })
  content.value = ''
  objectType.value = 'Note'
  articleTitle.value = ''
  articleSummary.value = ''
  spoilerText.value = ''
  showCw.value = false
  compose.mediaAttachments.splice(0)
  compose.clearQuote()
}
</script>

<template>
  <form
    @submit.prevent="submit"
    class="border-b border-gray-200 dark:border-gray-700 last:border-b-0 px-4 py-3 bg-transparent text-gray-900 dark:text-gray-100"
  >
    <!-- Hidden file input -->
    <input
      ref="fileInput"
      type="file"
      accept="image/*,video/*,audio/*,.webp,.gif"
      multiple
      class="hidden"
      @change="onFileSelect"
    />

    <div class="flex flex-wrap items-center gap-2 mb-3">
      <!-- Visibility selector -->
      <Listbox v-model="selectedVisibility">
        <div class="relative">
          <ListboxButton
            class="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-indigo-300 dark:border-indigo-500/70 text-sm text-indigo-700 dark:text-indigo-200 bg-indigo-50/60 dark:bg-indigo-950/30 hover:bg-indigo-100 dark:hover:bg-indigo-900/40 transition-colors"
            :aria-label="t('compose.visibility.label')"
            :title="t('compose.visibility.label')"
          >
            <span>{{ selectedVisibility.icon }}</span>
            <span class="inline-flex flex-col items-start leading-tight">
              <span class="text-[11px] font-medium opacity-75">{{ t('compose.post_visibility_label') }}</span>
              <span class="font-semibold">{{ t(selectedVisibility.label) }}</span>
            </span>
          </ListboxButton>
          <ListboxOptions
            class="absolute left-0 top-full mt-1 w-56 rounded-lg bg-white dark:bg-gray-900 shadow-lg border border-gray-200 dark:border-gray-700 py-1 z-20"
          >
            <ListboxOption
              v-for="option in visibilityOptions"
              :key="option.value"
              v-slot="{ active, selected }"
              :value="option"
            >
              <button
                type="button"
                class="w-full flex items-center gap-3 px-3 py-2 text-left text-sm"
                :class="[
                  active ? 'bg-gray-100 dark:bg-gray-800' : '',
                  selected ? 'font-semibold text-indigo-600 dark:text-indigo-300' : 'text-gray-700 dark:text-gray-200',
                ]"
              >
                <span>{{ option.icon }}</span>
                <span>{{ t(option.label) }}</span>
              </button>
            </ListboxOption>
          </ListboxOptions>
        </div>
      </Listbox>

      <!-- Quote policy selector -->
      <Listbox v-model="compose.quotePolicy">
        <div class="relative">
          <ListboxButton
            class="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-indigo-300 dark:border-indigo-500/70 text-sm text-indigo-700 dark:text-indigo-200 bg-indigo-50/60 dark:bg-indigo-950/30 hover:bg-indigo-100 dark:hover:bg-indigo-900/40 transition-colors"
            :aria-label="t('compose.quote_policy.label')"
            :title="t('compose.quote_policy.label')"
          >
            <span>{{ quotePolicyIcons[compose.quotePolicy] }}</span>
            <span class="inline-flex flex-col items-start leading-tight">
              <span class="text-[11px] font-medium opacity-75">{{ t('compose.quote_permission_label') }}</span>
              <span class="font-semibold">{{ t(`compose.quote_policy.${compose.quotePolicy}`) }}</span>
            </span>
          </ListboxButton>
          <ListboxOptions
            class="absolute left-0 top-full mt-1 z-20 w-48 rounded-lg bg-white dark:bg-gray-900 shadow-lg border border-gray-200 dark:border-gray-700 py-1"
          >
            <ListboxOption
              v-for="opt in quotePolicyOptions"
              :key="opt.value"
              v-slot="{ active, selected }"
              :value="opt.value"
            >
              <button
                type="button"
                class="w-full flex items-center gap-3 px-3 py-2 text-left text-sm"
                :class="[
                  active ? 'bg-gray-100 dark:bg-gray-800' : '',
                  selected ? 'font-semibold text-indigo-600 dark:text-indigo-300' : 'text-gray-700 dark:text-gray-200',
                ]"
              >
                <span>{{ quotePolicyIcons[opt.value] }}</span>
                <span>{{ t(opt.label) }}</span>
              </button>
            </ListboxOption>
          </ListboxOptions>
        </div>
      </Listbox>

      <!-- Language selector -->
      <Listbox v-model="selectedLanguage">
        <div class="relative">
          <ListboxButton
            class="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-indigo-300 dark:border-indigo-500/70 text-sm text-indigo-700 dark:text-indigo-200 bg-indigo-50/60 dark:bg-indigo-950/30 hover:bg-indigo-100 dark:hover:bg-indigo-900/40 transition-colors"
            :aria-label="t('compose.language')"
            :title="t('compose.language')"
          >
            <span>文</span>
            <span class="inline-flex flex-col items-start leading-tight">
              <span class="text-[11px] font-medium opacity-75">{{ t('compose.post_language_label') }}</span>
              <span class="font-semibold">{{ selectedLanguage.label }}</span>
            </span>
          </ListboxButton>
          <ListboxOptions
            class="absolute left-0 top-full mt-1 w-40 max-h-56 overflow-auto rounded-lg bg-white dark:bg-gray-900 shadow-lg border border-gray-200 dark:border-gray-700 py-1 z-20"
          >
            <ListboxOption
              v-for="lang in languageOptions"
              :key="lang.code"
              v-slot="{ active, selected }"
              :value="lang"
            >
              <button
                type="button"
                class="w-full flex items-center gap-2 px-3 py-2 text-left text-sm"
                :class="[
                  active ? 'bg-gray-100 dark:bg-gray-800' : '',
                  selected ? 'font-semibold text-indigo-600 dark:text-indigo-300' : 'text-gray-700 dark:text-gray-200',
                ]"
              >
                <span class="uppercase font-mono text-xs text-gray-400 w-6">{{ lang.code }}</span>
                <span>{{ lang.label }}</span>
              </button>
            </ListboxOption>
          </ListboxOptions>
        </div>
      </Listbox>
    </div>

    <!-- Reply indicator -->
    <div v-if="replyTo" class="text-sm text-gray-500 dark:text-gray-400 mb-2">
      {{ t('compose.replying_to', { name: `@${replyTo.account.acct}` }) }}
    </div>

    <div v-if="objectType === 'Article'" class="mb-2">
      <input
        v-model="articleTitle"
        type="text"
        maxlength="200"
        :placeholder="t('compose.article_title_placeholder')"
        class="w-full rounded-lg border border-gray-300 bg-transparent px-3 py-2 text-xl font-bold text-gray-950 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-gray-700 dark:text-white dark:placeholder-gray-500"
      />
      <div class="mt-1 text-right text-xs text-gray-400">{{ articleTitle.length }}/200</div>
      <textarea
        v-model="articleSummary"
        maxlength="500"
        rows="2"
        :placeholder="t('compose.article_summary_placeholder')"
        class="mt-2 w-full resize-y rounded-lg border border-gray-300 bg-transparent px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-gray-700 dark:text-gray-100 dark:placeholder-gray-500"
      />
    </div>

    <!-- CW input -->
    <input
      v-if="showCw"
      v-model="spoilerText"
      type="text"
      :placeholder="t('compose.cw_placeholder')"
      class="w-full mb-2 px-3 py-2 text-sm border-x-4 border-y border-amber-400 dark:border-amber-500 rounded-lg bg-amber-50 dark:bg-amber-950/30 text-gray-900 dark:text-gray-100 placeholder-amber-700/70 dark:placeholder-amber-300/70 focus:outline-none focus:ring-2 focus:ring-amber-500"
    />

    <!-- Main textarea with autocomplete container -->
    <div class="relative">
      <textarea
        ref="textareaRef"
        v-model="content"
        :placeholder="t('compose.placeholder')"
        rows="5"
        class="w-full px-0 py-2 text-lg leading-relaxed bg-transparent border-0 resize-none focus:outline-none text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500"
        @paste="onPaste"
        @drop.prevent="onDrop"
        @dragover.prevent
        :aria-label="t('compose.placeholder')"
        @input="onTextareaInput"
        @keydown="onTextareaKeydown"
      />

      <!-- Autocomplete dropdown -->
      <div
        v-if="autocompleteVisible && autocompleteItems.length > 0"
        ref="autocompleteRef"
        class="absolute left-2 right-2 bottom-full mb-1 z-20 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 overflow-hidden max-h-52 overflow-y-auto"
      >
        <button
          v-for="(item, idx) in autocompleteItems"
          :key="item.key"
          type="button"
          class="w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors"
          :class="idx === autocompleteIndex
            ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300'
            : 'hover:bg-gray-50 dark:hover:bg-gray-700/50 text-gray-700 dark:text-gray-300'"
          @click="selectAutocompleteItem(item)"
          @mouseenter="autocompleteIndex = idx"
        >
          <img
            v-if="item.image"
            :src="item.image"
            :alt="item.label"
            class="w-6 h-6 rounded object-cover flex-shrink-0"
            loading="lazy"
          />
          <span class="truncate">{{ item.label }}</span>
          <span v-if="item.sublabel" class="text-xs text-gray-400 dark:text-gray-500 truncate">{{ item.sublabel }}</span>
        </button>
      </div>
    </div>

    <!-- Media previews -->
    <div v-if="compose.mediaAttachments.length > 0" class="flex gap-2 mt-2 flex-wrap">
      <div
        v-for="media in compose.mediaAttachments"
        :key="media.id"
        class="relative group w-24 h-24 rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700"
      >
        <img
          v-if="media.type === 'image' || media.type === 'gifv'"
          :src="media.preview_url ?? media.url"
          :alt="media.description ?? ''"
          class="w-full h-full object-cover"
        />
        <div v-else class="w-full h-full flex items-center justify-center bg-gray-100 dark:bg-gray-800 text-2xl">
          {{ media.type === 'video' ? '🎬' : '🎵' }}
        </div>
        <!-- ALT button -->
        <button
          type="button"
          @click="openAltEditor(media)"
          class="absolute bottom-1 left-1 px-1.5 py-0.5 rounded text-[10px] font-bold transition-opacity"
          :class="media.description ? 'bg-indigo-500 text-white opacity-90' : 'bg-black/60 text-white opacity-0 group-hover:opacity-100'"
        >
          ALT
        </button>
        <!-- Remove button -->
        <button
          type="button"
          @click="compose.removeMedia(media.id)"
          class="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/60 text-white text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/80"
          aria-label="Remove"
        >
          ✕
        </button>
      </div>
    </div>

    <!-- Quote preview -->
    <div
      v-if="compose.quoteStatus"
      class="mt-3 border border-gray-200 dark:border-gray-700 rounded-lg p-3 bg-gray-50 dark:bg-gray-800/50"
    >
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="text-xs text-gray-500 dark:text-gray-400 truncate">
            @{{ compose.quoteStatus.account.acct }}
          </div>
          <div
            class="mt-1 text-sm text-gray-800 dark:text-gray-100 line-clamp-3"
            v-html="compose.quoteStatus.content"
          />
        </div>
        <button
          type="button"
          class="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500"
          :aria-label="t('common.cancel')"
          @click="compose.clearQuote()"
        >
          ✕
        </button>
      </div>
    </div>

    <!-- ALT text editor modal -->
    <div v-if="altEditMedia" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50" @click.self="altEditMedia = null">
      <div class="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-md mx-4 p-4">
        <div class="flex items-center justify-between mb-3">
          <h3 class="font-bold text-sm">{{ t('compose.alt_text') }}</h3>
          <button type="button" @click="altEditMedia = null" class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">✕</button>
        </div>
        <img
          v-if="altEditMedia.type === 'image' || altEditMedia.type === 'gifv'"
          :src="altEditMedia.preview_url ?? altEditMedia.url"
          class="w-full h-40 object-contain rounded-lg bg-gray-100 dark:bg-gray-900 mb-3"
        />
        <textarea
          v-model="altEditText"
          :placeholder="t('compose.alt_placeholder')"
          rows="3"
          class="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-transparent focus:outline-none focus:ring-2 focus:ring-indigo-500"
          maxlength="1500"
        />
        <div class="flex justify-between items-center mt-2">
          <span class="text-xs text-gray-400">{{ altEditText.length }}/1500</span>
          <button
            type="button"
            @click="saveAlt"
            class="px-4 py-1.5 text-sm font-medium bg-indigo-500 text-white rounded-lg hover:bg-indigo-600"
          >
            {{ t('common.save') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Poll editor -->
    <div v-if="compose.showPoll" class="mt-3 p-3 border border-gray-200 dark:border-gray-700 rounded-lg space-y-2">
      <div v-for="(_, idx) in compose.pollOptions" :key="idx" class="flex items-center gap-2">
        <span class="text-xs text-gray-400 w-4">{{ idx + 1 }}</span>
        <input
          v-model="compose.pollOptions[idx]"
          type="text"
          :placeholder="t('compose.poll_option_placeholder', { n: idx + 1 })"
          maxlength="50"
          class="flex-1 px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-transparent focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <button
          v-if="compose.pollOptions.length > 2"
          type="button"
          @click="compose.pollOptions.splice(idx, 1)"
          class="p-1 text-gray-400 hover:text-red-500 transition-colors"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
      </div>

      <button
        v-if="compose.pollOptions.length < 4"
        type="button"
        @click="compose.pollOptions.push('')"
        class="text-sm text-indigo-600 dark:text-indigo-400 hover:underline"
      >
        + {{ t('compose.poll_add_option') }}
      </button>

      <div class="flex items-center gap-4 pt-2 border-t border-gray-200 dark:border-gray-700">
        <label class="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
          <input v-model="compose.pollMultiple" type="checkbox" class="rounded border-gray-300 dark:border-gray-600" />
          {{ t('compose.poll_multiple') }}
        </label>

        <select
          v-model.number="compose.pollExpiresIn"
          class="text-sm px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
        >
          <option :value="300">5 {{ t('compose.poll_minutes') }}</option>
          <option :value="1800">30 {{ t('compose.poll_minutes') }}</option>
          <option :value="3600">1 {{ t('compose.poll_hours') }}</option>
          <option :value="21600">6 {{ t('compose.poll_hours') }}</option>
          <option :value="43200">12 {{ t('compose.poll_hours') }}</option>
          <option :value="86400">1 {{ t('compose.poll_days') }}</option>
          <option :value="259200">3 {{ t('compose.poll_days') }}</option>
          <option :value="604800">7 {{ t('compose.poll_days') }}</option>
        </select>
      </div>
    </div>

    <!-- Upload progress -->
    <div v-if="compose.uploading" class="flex items-center gap-2 mt-2 text-sm text-gray-500 dark:text-gray-400">
      <svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
      {{ t('compose.uploading') }}
    </div>

    <!-- Toolbar -->
    <div class="flex items-center justify-between mt-3 pt-3 border-t border-gray-200 dark:border-gray-800">
      <div class="flex items-center gap-1.5 flex-wrap">
        <!-- Media upload -->
        <button
          type="button"
          @click="triggerFileInput"
          :disabled="compose.mediaAttachments.length >= 4 || compose.uploading || compose.showPoll"
          class="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-indigo-600 dark:text-indigo-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          :aria-label="t('compose.add_media')"
          :title="t('compose.add_media')"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.7" d="M4 16l4.6-4.6a2 2 0 012.8 0L16 16m-2-2l1.6-1.6a2 2 0 012.8 0L20 14m-14 6h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2zm3-11h.01" /></svg>
        </button>

        <!-- CW toggle -->
        <button
          type="button"
          @click="showCw = !showCw"
          class="p-2 rounded-lg transition-colors"
          :class="showCw
            ? 'bg-indigo-600 text-white'
            : 'text-indigo-600 dark:text-indigo-300 hover:bg-gray-100 dark:hover:bg-gray-800'"
          :aria-label="t('compose.toggle_cw')"
          :title="t('compose.toggle_cw')"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.7" d="M12 9v4m0 4h.01M10.3 4.3L2.8 17.3A2 2 0 004.5 20h15a2 2 0 001.7-2.7L13.7 4.3a2 2 0 00-3.4 0z" /></svg>
        </button>

        <!-- Poll toggle -->
        <button
          type="button"
          @click="togglePoll"
          :disabled="compose.mediaAttachments.length > 0 || objectType === 'Article'"
          class="p-2 rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          :class="compose.showPoll ? 'bg-indigo-600 text-white' : 'text-indigo-600 dark:text-indigo-300 hover:bg-gray-100 dark:hover:bg-gray-800'"
          :aria-label="t('compose.poll_toggle')"
          :title="t('compose.poll_toggle')"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.7" d="M4 19V9m5 10V5m5 14v-7m5 7V8" /></svg>
        </button>

        <!-- Article toggle -->
        <button
          type="button"
          @click="toggleArticle"
          class="rounded-lg px-2.5 py-2 text-sm font-bold transition-colors"
          :class="objectType === 'Article'
            ? 'bg-indigo-600 text-white'
            : 'text-indigo-600 hover:bg-gray-100 dark:text-indigo-300 dark:hover:bg-gray-800'"
          :aria-label="t('compose.article_toggle')"
          :title="t('compose.article_toggle')"
        >A</button>

        <!-- Emoji picker -->
        <div class="relative" ref="emojiPickerRef">
          <button
            type="button"
            ref="emojiButtonRef"
            @click.stop="toggleEmojiPicker"
            class="p-2 rounded-lg text-indigo-600 dark:text-indigo-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            :class="showEmojiPicker ? 'bg-indigo-600 text-white hover:bg-indigo-600' : ''"
            :aria-label="t('compose.emoji_picker')"
            :title="t('compose.emoji_picker')"
          >
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.7" d="M15.2 15.2a4.5 4.5 0 01-6.4 0M9 9.5h.01M15 9.5h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
          </button>
          <Teleport to="body">
            <div
              v-if="showEmojiPicker"
              class="fixed z-[9999]"
              :style="emojiPickerPosition"
              @click.stop
            >
              <EmojiPicker @select="onEmojiSelect" />
            </div>
          </Teleport>
        </div>

        <!-- Media count -->
        <span v-if="compose.mediaAttachments.length > 0" class="text-xs text-gray-400 dark:text-gray-500">
          {{ compose.mediaAttachments.length }}/4
        </span>
      </div>

      <div class="flex items-center gap-3">
        <!-- Char counter -->
        <span
          class="text-sm"
          :class="charsRemaining < 0 ? 'text-red-500' : 'text-gray-400 dark:text-gray-500'"
        >
          {{ charsRemaining }}
        </span>

        <!-- Submit -->
        <button
          type="submit"
          :disabled="!canSubmit || compose.publishing"
          class="px-4 py-1.5 rounded-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-sm disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
        >
          <svg v-if="compose.publishing" class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
          {{ t('compose.submit') }}
        </button>
      </div>
    </div>
  </form>
</template>
