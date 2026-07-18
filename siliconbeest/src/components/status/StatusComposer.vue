<script setup lang="ts">
import { ref, computed, nextTick, watch, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Listbox, ListboxButton, ListboxOptions, ListboxOption } from '@headlessui/vue'
import { useComposeStore } from '@/stores/compose'
import { useEmojis } from '@/composables/useEmojis'
import { search as apiSearch } from '@/api/mastodon/search'
import { useAuthStore } from '@/stores/auth'
import EmojiPicker from '@/components/common/EmojiPicker.vue'

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
    spoiler_text: string
    visibility: string
    language: string
    in_reply_to_id?: string
    quote_id?: string
    quote_policy?: import('@/types/mastodon').QuotePolicy
    media_ids?: string[]
  }]
}>()

const content = ref('')
const objectType = ref<'Note' | 'Article'>('Note')
const articleTitle = ref('')
const spoilerText = ref('')
const showCw = ref(false)
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

const canSubmit = computed(() => {
  const hasContent = content.value.trim().length > 0 || compose.mediaAttachments.length > 0 || !!compose.quoteStatus
  const validTitle = objectType.value !== 'Article'
    || (articleTitle.value.trim().length > 0 && articleTitle.value.length <= 200)
  return hasContent && validTitle && charsRemaining.value >= 0 && !compose.uploading
})

function toggleArticle() {
  objectType.value = objectType.value === 'Article' ? 'Note' : 'Article'
  if (objectType.value === 'Article' && compose.showPoll) togglePoll()
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
    await compose.addMedia(file)
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
        await compose.addMedia(file)
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
      await compose.addMedia(file)
    }
  }
}

function submit() {
  if (!canSubmit.value) return
  emit('submit', {
    content: content.value,
    object_type: objectType.value,
    title: objectType.value === 'Article' ? articleTitle.value.trim() : undefined,
    spoiler_text: showCw.value ? spoilerText.value : '',
    visibility: selectedVisibility.value.value,
    language: selectedLanguage.value.code,
    in_reply_to_id: props.replyTo?.id,
    quote_id: compose.quoteId ?? undefined,
    quote_policy: compose.quotePolicy,
    media_ids: compose.mediaAttachments.map(m => m.id),
  })
  // Draft is NOT cleared here — publishing may still fail. The compose
  // store bumps publishedTick only on success (its reset() clears media
  // and quote state), and the watcher below clears the local fields then.
}

watch(() => compose.publishedTick, () => {
  content.value = ''
  objectType.value = 'Note'
  articleTitle.value = ''
  spoilerText.value = ''
  showCw.value = false
})
</script>

<template>
  <form
    @submit.prevent="submit"
    class="border-b border-outline dark:border-outline-dark last:border-b-0 px-4 py-4 bg-transparent text-slate-900 dark:text-slate-100"
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
            class="inline-flex items-center gap-2 rounded-xl border border-outline bg-surface px-3 py-1.5 text-sm text-slate-700 shadow-soft transition-all hover:border-brand-300 hover:bg-brand-50/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 dark:border-outline-dark dark:bg-surface-2-dark dark:text-slate-200 dark:hover:border-brand-700 dark:hover:bg-brand-950/30"
            :aria-label="t('compose.visibility.label')"
            :title="t('compose.visibility.label')"
          >
            <span>{{ selectedVisibility.icon }}</span>
            <span class="inline-flex flex-col items-start leading-tight">
              <span class="text-[11px] font-medium text-slate-400 dark:text-slate-500">{{ t('compose.post_visibility_label') }}</span>
              <span class="font-semibold">{{ t(selectedVisibility.label) }}</span>
            </span>
          </ListboxButton>
          <ListboxOptions
            class="sb-menu absolute left-0 top-full z-20 mt-1.5 w-56"
          >
            <ListboxOption
              v-for="option in visibilityOptions"
              :key="option.value"
              v-slot="{ active, selected }"
              :value="option"
            >
              <button
                type="button"
                class="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors"
                :class="[
                  active ? 'bg-surface-2 dark:bg-white/5' : '',
                  selected ? 'font-semibold text-brand-600 dark:text-brand-300' : 'text-slate-700 dark:text-slate-200',
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
            class="inline-flex items-center gap-2 rounded-xl border border-outline bg-surface px-3 py-1.5 text-sm text-slate-700 shadow-soft transition-all hover:border-brand-300 hover:bg-brand-50/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 dark:border-outline-dark dark:bg-surface-2-dark dark:text-slate-200 dark:hover:border-brand-700 dark:hover:bg-brand-950/30"
            :aria-label="t('compose.quote_policy.label')"
            :title="t('compose.quote_policy.label')"
          >
            <span>{{ quotePolicyIcons[compose.quotePolicy] }}</span>
            <span class="inline-flex flex-col items-start leading-tight">
              <span class="text-[11px] font-medium text-slate-400 dark:text-slate-500">{{ t('compose.quote_permission_label') }}</span>
              <span class="font-semibold">{{ t(`compose.quote_policy.${compose.quotePolicy}`) }}</span>
            </span>
          </ListboxButton>
          <ListboxOptions
            class="sb-menu absolute left-0 top-full z-20 mt-1.5 w-52"
          >
            <ListboxOption
              v-for="opt in quotePolicyOptions"
              :key="opt.value"
              v-slot="{ active, selected }"
              :value="opt.value"
            >
              <button
                type="button"
                class="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors"
                :class="[
                  active ? 'bg-surface-2 dark:bg-white/5' : '',
                  selected ? 'font-semibold text-brand-600 dark:text-brand-300' : 'text-slate-700 dark:text-slate-200',
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
            class="inline-flex items-center gap-2 rounded-xl border border-outline bg-surface px-3 py-1.5 text-sm text-slate-700 shadow-soft transition-all hover:border-brand-300 hover:bg-brand-50/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 dark:border-outline-dark dark:bg-surface-2-dark dark:text-slate-200 dark:hover:border-brand-700 dark:hover:bg-brand-950/30"
            :aria-label="t('compose.language')"
            :title="t('compose.language')"
          >
            <span>文</span>
            <span class="inline-flex flex-col items-start leading-tight">
              <span class="text-[11px] font-medium text-slate-400 dark:text-slate-500">{{ t('compose.post_language_label') }}</span>
              <span class="font-semibold">{{ selectedLanguage.label }}</span>
            </span>
          </ListboxButton>
          <ListboxOptions
            class="sb-menu absolute left-0 top-full z-20 mt-1.5 max-h-56 w-44 overflow-auto"
          >
            <ListboxOption
              v-for="lang in languageOptions"
              :key="lang.code"
              v-slot="{ active, selected }"
              :value="lang"
            >
              <button
                type="button"
                class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors"
                :class="[
                  active ? 'bg-surface-2 dark:bg-white/5' : '',
                  selected ? 'font-semibold text-brand-600 dark:text-brand-300' : 'text-slate-700 dark:text-slate-200',
                ]"
              >
                <span class="w-6 font-mono text-xs uppercase text-slate-400 dark:text-slate-500">{{ lang.code }}</span>
                <span>{{ lang.label }}</span>
              </button>
            </ListboxOption>
          </ListboxOptions>
        </div>
      </Listbox>
    </div>

    <!-- Reply indicator -->
    <div v-if="replyTo" class="mb-2 text-sm text-slate-500 dark:text-slate-400">
      {{ t('compose.replying_to', { name: `@${replyTo.account.acct}` }) }}
    </div>

    <div v-if="objectType === 'Article'" class="mb-2">
      <input
        v-model="articleTitle"
        type="text"
        maxlength="200"
        :placeholder="t('compose.article_title_placeholder')"
        class="w-full rounded-xl border border-outline bg-surface px-3.5 py-3 text-xl font-bold text-slate-950 transition placeholder:text-slate-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20 dark:border-outline-dark dark:bg-surface-2-dark dark:text-white dark:placeholder:text-slate-500"
      />
      <div class="mt-1 text-right text-xs tabular-nums text-slate-400">{{ articleTitle.length }}/200</div>
    </div>

    <!-- CW input -->
    <input
      v-if="showCw"
      v-model="spoilerText"
      type="text"
      :placeholder="t('compose.cw_placeholder')"
      class="mb-2 w-full rounded-xl border border-amber-300 bg-amber-50/70 px-3.5 py-2.5 text-sm text-slate-900 transition placeholder:text-amber-700/60 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-500/30 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-slate-100 dark:placeholder:text-amber-300/60"
    />

    <!-- Main textarea with autocomplete container -->
    <div class="relative">
      <textarea
        ref="textareaRef"
        v-model="content"
        :placeholder="t('compose.placeholder')"
        rows="5"
        class="w-full resize-none rounded-xl border border-outline bg-surface px-3.5 py-3 text-base leading-relaxed text-slate-900 transition placeholder:text-slate-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20 dark:border-outline-dark dark:bg-surface-2-dark dark:text-slate-100 dark:placeholder:text-slate-500"
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
        class="sb-menu absolute left-0 right-0 bottom-full z-20 mb-1.5 max-h-52 overflow-y-auto"
      >
        <button
          v-for="(item, idx) in autocompleteItems"
          :key="item.key"
          type="button"
          class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors"
          :class="idx === autocompleteIndex
            ? 'bg-brand-50 text-brand-700 dark:bg-brand-950/50 dark:text-brand-300'
            : 'text-slate-700 dark:text-slate-300'"
          @click="selectAutocompleteItem(item)"
          @mouseenter="autocompleteIndex = idx"
        >
          <img
            v-if="item.image"
            :src="item.image"
            :alt="item.label"
            class="h-6 w-6 flex-shrink-0 rounded-md object-cover"
            loading="lazy"
          />
          <span class="truncate">{{ item.label }}</span>
          <span v-if="item.sublabel" class="truncate text-xs text-slate-400 dark:text-slate-500">{{ item.sublabel }}</span>
        </button>
      </div>
    </div>

    <!-- Media previews -->
    <div v-if="compose.mediaAttachments.length > 0" class="flex gap-2 mt-2 flex-wrap">
      <div
        v-for="media in compose.mediaAttachments"
        :key="media.id"
        class="group relative h-24 w-24 overflow-hidden rounded-xl ring-1 ring-outline dark:ring-outline-dark"
      >
        <img
          v-if="media.type === 'image' || media.type === 'gifv'"
          :src="media.preview_url ?? media.url"
          :alt="media.description ?? ''"
          class="w-full h-full object-cover"
        />
        <div v-else class="flex h-full w-full items-center justify-center bg-surface-2 text-2xl dark:bg-surface-2-dark">
          {{ media.type === 'video' ? '🎬' : '🎵' }}
        </div>
        <!-- ALT button -->
        <button
          type="button"
          @click="openAltEditor(media)"
          class="absolute bottom-1 left-1 rounded-md px-1.5 py-0.5 text-[10px] font-bold tracking-wide backdrop-blur-sm transition-opacity"
          :class="media.description ? 'bg-brand-600/90 text-white opacity-95' : 'bg-slate-950/60 text-white opacity-0 group-hover:opacity-100'"
        >
          ALT
        </button>
        <!-- Remove button -->
        <button
          type="button"
          @click="compose.removeMedia(media.id)"
          class="absolute top-1 right-1 flex h-6 w-6 items-center justify-center rounded-full bg-slate-950/60 text-xs text-white opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100 hover:bg-slate-950/80"
          :aria-label="t('common.remove')"
        >
          ✕
        </button>
      </div>
    </div>

    <!-- Quote preview -->
    <div
      v-if="compose.quoteStatus"
      class="mt-3 rounded-xl border border-outline bg-surface-2/60 p-3 dark:border-outline-dark dark:bg-surface-2-dark/60"
    >
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="truncate text-xs font-medium text-slate-500 dark:text-slate-400">
            @{{ compose.quoteStatus.account.acct }}
          </div>
          <div
            class="mt-1 text-sm text-slate-800 dark:text-slate-100 line-clamp-3"
            v-html="compose.quoteStatus.content"
          />
        </div>
        <button
          type="button"
          class="rounded-lg p-1 text-slate-400 transition-colors hover:bg-surface-2 hover:text-slate-600 dark:hover:bg-white/10 dark:hover:text-slate-300"
          :aria-label="t('common.cancel')"
          @click="compose.clearQuote()"
        >
          ✕
        </button>
      </div>
    </div>

    <!-- ALT text editor modal -->
    <div v-if="altEditMedia" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-sm" @click.self="altEditMedia = null">
      <div class="sb-card mx-4 w-full max-w-md p-5">
        <div class="mb-3 flex items-center justify-between">
          <h3 class="sb-heading text-sm">{{ t('compose.alt_text') }}</h3>
          <button type="button" @click="altEditMedia = null" class="rounded-lg p-1 text-slate-400 transition-colors hover:bg-surface-2 hover:text-slate-600 dark:hover:bg-white/10 dark:hover:text-slate-300">✕</button>
        </div>
        <img
          v-if="altEditMedia.type === 'image' || altEditMedia.type === 'gifv'"
          :src="altEditMedia.preview_url ?? altEditMedia.url"
          class="mb-3 h-40 w-full rounded-xl bg-surface-2 object-contain dark:bg-canvas-dark"
        />
        <textarea
          v-model="altEditText"
          :placeholder="t('compose.alt_placeholder')"
          rows="3"
          class="sb-input resize-none"
          maxlength="1500"
        />
        <div class="mt-3 flex items-center justify-between">
          <span class="text-xs tabular-nums text-slate-400 dark:text-slate-500">{{ altEditText.length }}/1500</span>
          <button
            type="button"
            @click="saveAlt"
            class="sb-btn sb-btn-primary sb-btn-sm"
          >
            {{ t('common.save') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Poll editor -->
    <div v-if="compose.showPoll" class="mt-3 space-y-2.5 rounded-xl border border-outline bg-surface-2/50 p-3.5 dark:border-outline-dark dark:bg-surface-2-dark/40">
      <div v-for="(_, idx) in compose.pollOptions" :key="idx" class="flex items-center gap-2">
        <span class="w-4 text-xs font-semibold tabular-nums text-slate-400 dark:text-slate-500">{{ idx + 1 }}</span>
        <input
          v-model="compose.pollOptions[idx]"
          type="text"
          :placeholder="t('compose.poll_option_placeholder', { n: idx + 1 })"
          maxlength="50"
          class="sb-input flex-1"
        />
        <button
          v-if="compose.pollOptions.length > 2"
          type="button"
          @click="compose.pollOptions.splice(idx, 1)"
          class="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/40"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
      </div>

      <button
        v-if="compose.pollOptions.length < 4"
        type="button"
        @click="compose.pollOptions.push('')"
        class="inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-sm font-medium text-brand-600 transition-colors hover:bg-brand-50 dark:text-brand-400 dark:hover:bg-brand-950/40"
      >
        + {{ t('compose.poll_add_option') }}
      </button>

      <div class="flex items-center gap-4 border-t border-outline pt-2.5 dark:border-outline-dark">
        <label class="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
          <input v-model="compose.pollMultiple" type="checkbox" class="h-4 w-4 rounded border-outline accent-brand-600 dark:border-outline-dark" />
          {{ t('compose.poll_multiple') }}
        </label>

        <select
          v-model.number="compose.pollExpiresIn"
          class="rounded-xl border border-outline bg-surface px-2.5 py-1.5 text-sm text-slate-900 transition focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20 dark:border-outline-dark dark:bg-surface-2-dark dark:text-slate-100"
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
    <div v-if="compose.uploading" class="mt-2 flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
      <svg class="h-4 w-4 animate-spin text-brand-500" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
      {{ t('compose.uploading') }}
    </div>

    <!-- Toolbar -->
    <div class="mt-3 flex items-center justify-between border-t border-outline pt-3 dark:border-outline-dark">
      <div class="flex items-center gap-1.5 flex-wrap">
        <!-- Media upload -->
        <button
          type="button"
          @click="triggerFileInput"
          :disabled="compose.mediaAttachments.length >= 4 || compose.uploading || compose.showPoll"
          class="sb-btn sb-btn-ghost rounded-xl p-2 text-brand-600 hover:bg-brand-50 hover:text-brand-700 dark:text-brand-400 dark:hover:bg-brand-950/40 dark:hover:text-brand-300"
          :aria-label="t('compose.add_media')"
          :title="t('compose.add_media')"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.7" d="M4 16l4.6-4.6a2 2 0 012.8 0L16 16m-2-2l1.6-1.6a2 2 0 012.8 0L20 14m-14 6h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2zm3-11h.01" /></svg>
        </button>

        <!-- CW toggle -->
        <button
          type="button"
          @click="showCw = !showCw"
          class="sb-btn sb-btn-ghost rounded-xl p-2"
          :class="showCw
            ? 'bg-brand-600 text-white shadow-soft hover:bg-brand-600 hover:text-white dark:bg-brand-500 dark:hover:bg-brand-500'
            : 'text-brand-600 hover:bg-brand-50 hover:text-brand-700 dark:text-brand-400 dark:hover:bg-brand-950/40 dark:hover:text-brand-300'"
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
          class="sb-btn sb-btn-ghost rounded-xl p-2"
          :class="compose.showPoll
            ? 'bg-brand-600 text-white shadow-soft hover:bg-brand-600 hover:text-white dark:bg-brand-500 dark:hover:bg-brand-500'
            : 'text-brand-600 hover:bg-brand-50 hover:text-brand-700 dark:text-brand-400 dark:hover:bg-brand-950/40 dark:hover:text-brand-300'"
          :aria-label="t('compose.poll_toggle')"
          :title="t('compose.poll_toggle')"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.7" d="M4 19V9m5 10V5m5 14v-7m5 7V8" /></svg>
        </button>

        <!-- Article toggle -->
        <button
          type="button"
          @click="toggleArticle"
          class="sb-btn sb-btn-ghost rounded-xl px-2.5 py-2 text-sm font-bold"
          :class="objectType === 'Article'
            ? 'bg-brand-600 text-white shadow-soft hover:bg-brand-600 hover:text-white dark:bg-brand-500'
            : 'text-brand-600 hover:bg-brand-50 dark:text-brand-400 dark:hover:bg-brand-950/40'"
          :aria-label="t('compose.article_toggle')"
          :title="t('compose.article_toggle')"
        >A</button>

        <!-- Emoji picker -->
        <div class="relative" ref="emojiPickerRef">
          <button
            type="button"
            ref="emojiButtonRef"
            @click.stop="toggleEmojiPicker"
            class="sb-btn sb-btn-ghost rounded-xl p-2"
            :class="showEmojiPicker
              ? 'bg-brand-600 text-white shadow-soft hover:bg-brand-600 hover:text-white dark:bg-brand-500 dark:hover:bg-brand-500'
              : 'text-brand-600 hover:bg-brand-50 hover:text-brand-700 dark:text-brand-400 dark:hover:bg-brand-950/40 dark:hover:text-brand-300'"
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
        <span v-if="compose.mediaAttachments.length > 0" class="sb-chip tabular-nums">
          {{ compose.mediaAttachments.length }}/4
        </span>
      </div>

      <div class="flex items-center gap-3">
        <!-- Char counter -->
        <span
          class="text-sm tabular-nums"
          :class="charsRemaining < 0 ? 'font-semibold text-red-500' : 'text-slate-400 dark:text-slate-500'"
        >
          {{ charsRemaining }}
        </span>

        <!-- Submit -->
        <button
          type="submit"
          :disabled="!canSubmit || compose.publishing"
          class="sb-btn sb-btn-primary"
        >
          <svg v-if="compose.publishing" class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
          {{ t('compose.submit') }}
        </button>
      </div>
    </div>
  </form>
</template>
